/**
 * dsh-patrol — a DeepSeek Harness plugin that turns a row-based task source into DSH-native work.
 *
 * The plugin does four things and nothing else:
 *   1. reads a direction table (Feishu Bitable by default) through a Source;
 *   2. turns each due row into a Trigger (content-addressed, so an unchanged row re-triggers nothing);
 *   3. admits it under a versioned Policy — Gate in code, Assessment by the model;
 *   4. opens a Ticket for what was admitted and dispatches it.
 *
 * Everything vendor-specific lives in the Source and the Dispatcher; the domain model does not
 * know what a spreadsheet is.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { Engine, type DecisionRecord } from './core/engine.ts'
import { DirectionPolicy } from './core/policy.ts'
import { FunctionAssessor, type Assessor } from './core/eval.ts'
import { BitableSource } from './source/bitable.ts'
import { LocalJsonSource } from './source/local-json.ts'
import type { SourceProvider } from './source/provider.ts'
import { CodexDispatcher, DshDispatcher, LogDispatcher, type Dispatcher } from './dispatch.ts'
import { PatrolRunner } from './runner.ts'

/** Plugin configuration. */
export const Config = z.object({
  /** Which source to read. */
  kind: z.enum(['bitable', 'local-json']).default('bitable'),
  /** Bitable base token (ignored for `local-json`). */
  baseToken: z.string().default(''),
  /** Bitable table id (ignored for `local-json`). */
  tableId: z.string().default(''),
  /** Path to the JSON file (used by `local-json`). */
  tasksFile: z.string().default(''),
  /** Identity used for the Bitable read. */
  identity: z.enum(['user', 'bot']).default('user'),
  /** Version of the Policy; a change is recorded on every Mandate. */
  policyVersion: z.string().default('v1'),
  /** Whether the Policy admits anything at all. */
  paused: z.boolean().default(false),
  /** `observe` records what would have been accepted and starts nothing. */
  acceptMode: z.enum(['off', 'observe', 'auto']).default('observe'),
  /** How often a round runs. */
  roundIntervalMs: z.number().int().min(1_000).default(600_000),
  /** Where admitted work goes. */
  dispatcher: z.enum(['log', 'codex', 'dsh']).default('log'),
  /** Extra arguments for the `codex` dispatcher. */
  codexArgs: z.array(z.string()).default([]),
})

export type PatrolConfig = z.infer<typeof Config>

export const name = 'dsh-patrol'
export const inject = ['agents', 'sessionController', 'sessions', 'skills', 'tools', 'logger']

/** Builds the Source named by the configuration. */
export function createSource(config: PatrolConfig): SourceProvider {
  if (config.kind === 'local-json') {
    if (!config.tasksFile) throw new Error('dsh-patrol: kind=local-json needs tasksFile')
    return new LocalJsonSource({ path: config.tasksFile })
  }
  if (!config.baseToken || !config.tableId) throw new Error('dsh-patrol: kind=bitable needs baseToken and tableId')
  return new BitableSource({ baseToken: config.baseToken, tableId: config.tableId, identity: config.identity })
}

/** Builds the Dispatcher named by the configuration. */
export function createDispatcher(config: PatrolConfig, ctx?: Context): Dispatcher {
  if (config.dispatcher === 'codex') return new CodexDispatcher({ extraArgs: config.codexArgs })
  if (config.dispatcher === 'dsh') {
    const controller = ctx?.get('sessionController' as never) as unknown as { prompt: (...args: never[]) => Promise<unknown> } | undefined
    if (!controller) throw new Error('dsh-patrol: dispatcher=dsh needs the sessionController service')
    return new DshDispatcher(controller as never)
  }
  return new LogDispatcher()
}

/**
 * The Assessment the plugin uses when the host does not supply one.
 *
 * It is deliberately conservative: a row with a concrete next step and an approved status is
 * accepted; anything else is ignored with a reason. A host that wants model judgement passes its
 * own Assessor to `createEngine`.
 */
export function defaultAssessor(acceptMode: 'off' | 'observe' | 'auto'): Assessor {
  return new FunctionAssessor((candidate) => {
    const trigger = candidate.triggers[0]
    const nextStep = String(trigger?.meta['nextStep'] ?? '').trim()
    if (!nextStep) return { kind: 'ignore', reason: 'no-next-step' }
    return {
      kind: 'accept',
      title: String(trigger?.meta['title'] ?? candidate.thread.key),
      scope: String(trigger?.meta['repoPath'] ?? '') || candidate.thread.key,
      reason: 'row-carries-next-step',
      rules: ['next-step-present'],
    }
  }, { mode: acceptMode })
}

/** Builds the Engine. A host may pass its own Assessor to use model judgement. */
export function createEngine(config: PatrolConfig, options: { assessor?: Assessor; dispatcher?: Dispatcher; onDecision?: (decision: DecisionRecord) => void } = {}): Engine {
  const policy = new DirectionPolicy({ version: config.policyVersion, paused: config.paused })
  const dispatcher = options.dispatcher ?? new LogDispatcher()
  return new Engine({
    policy,
    assessor: options.assessor ?? defaultAssessor(config.acceptMode),
    acceptMode: config.acceptMode,
    sink: { start: (ticket, _assignment) => { void dispatcher.dispatch(ticket, { fake: false }) } },
    onDecision: options.onDecision,
  })
}

/** Plugin entry point. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config.parse(rawConfig ?? {})
  const source = createSource(config)
  const dispatcher = createDispatcher(config, ctx)
  const engine = createEngine(config, { dispatcher, onDecision: (decision) => ctx.logger.info('dsh-patrol decision %s %s (%s)', decision.verdict, decision.threadKey, decision.reason) })
  const runner = new PatrolRunner({ source, engine, dispatcher })

  const timer = setInterval(() => {
    runner.runOnce().catch((error: unknown) => ctx.logger.error('dsh-patrol round failed: %s', String(error)))
  }, config.roundIntervalMs)
  timer.unref?.()

  ctx.effect(() => async () => {
    clearInterval(timer)
    ctx.logger.info('dsh-patrol stopped')
  })

  ctx.logger.info('dsh-patrol ready: source=%s acceptMode=%s dispatcher=%s', config.kind, config.acceptMode, dispatcher.kind)
}

export { Engine } from './core/engine.ts'
export { DirectionPolicy } from './core/policy.ts'
export { BitableSource } from './source/bitable.ts'
export { LocalJsonSource } from './source/local-json.ts'
export { PatrolRunner } from './runner.ts'
export type { DirectionItem, SourceProvider } from './source/provider.ts'
export type { Ticket, Trigger, Mandate, Assignment } from './core/model.ts'