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
import type {} from '@deepseek-ai/dsh-skill'
import { z } from 'zod'
import { Engine, type DecisionRecord } from './core/engine.ts'
import { DecisionLog } from './core/decision-log.ts'
import { DirectionPolicy } from './core/policy.ts'
import { FunctionAssessor, type Assessor } from './core/eval.ts'
import { BitableSource } from './source/bitable.ts'
import { LocalJsonSource } from './source/local-json.ts'
import type { SourceProvider } from './source/provider.ts'
import { CodexDispatcher, DshDispatcher, LogDispatcher, type Dispatcher, type DshSessionController } from './dispatch.ts'
import { readPackagedSkill, skillResourceBase } from './skill.ts'
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
  /**
   * Append-only JSONL audit trail of every decision. Empty means "no history", which is the
   * old behaviour exactly. A relative path resolves against the process working directory.
   */
  decisionLogPath: z.string().default(''),
  /**
   * Repo prefixes an unattended round may act inside. Empty means "no repo restriction" (the
   * old behaviour). Once set, a row with no repo, an uncloned repo, or a repo outside every
   * prefix is refused by the Gate before assessment - 现场 repositories stay out by default.
   */
  autonomousRepos: z.array(z.string()).default([]),
  /** How often a round runs. */
  roundIntervalMs: z.number().int().min(1_000).default(600_000),
  /** Where admitted work goes. */
  dispatcher: z.enum(['log', 'codex', 'dsh']).default('log'),
  /** Extra arguments for the `codex` dispatcher. */
  codexArgs: z.array(z.string()).default([]),
})

export type PatrolConfig = z.infer<typeof Config>

export const name = 'dsh-patrol'
/**
 * Host services this plugin actually reads: the session controller (only for the `dsh` dispatcher)
 * and the skill registry (to publish the packaged skill). Declaring a service here means the plugin
 * waits for it and is unloaded when it disappears, so the list stays short and honest.
 */
export const inject = ['sessionController', 'skills']

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
    const controller = ctx?.get('sessionController') as DshSessionController | undefined
    if (!controller) throw new Error('dsh-patrol: dispatcher=dsh needs the sessionController service')
    return new DshDispatcher(controller)
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
export function createEngine(
  config: PatrolConfig,
  options: {
    assessor?: Assessor
    dispatcher?: Dispatcher
    onDecision?: (decision: DecisionRecord) => void
    /** When present, every decision is also appended to this log. */
    decisionLog?: DecisionLog
  } = {},
): Engine {
  const policy = new DirectionPolicy({
    version: config.policyVersion,
    paused: config.paused,
    autonomousRepos: config.autonomousRepos,
  })
  const dispatcher = options.dispatcher ?? new LogDispatcher()
  const decisionLog = options.decisionLog
  return new Engine({
    policy,
    assessor: options.assessor ?? defaultAssessor(config.acceptMode),
    acceptMode: config.acceptMode,
    sink: { start: (ticket, _assignment) => { void dispatcher.dispatch(ticket, { fake: false }) } },
    onDecision: (decision) => {
      options.onDecision?.(decision)
      // A failed append is reported through the log's own onError callback; the patrol goes on.
      decisionLog?.append(decision)
    },
  })
}

/**
 * Builds the audit log named by the configuration.
 *
 * Returns `undefined` when `decisionLogPath` is unset: no file, no directory, no behaviour change.
 */
export function createDecisionLog(config: PatrolConfig, options: { onError?: (error: Error) => void; cwd?: string } = {}): DecisionLog | undefined {
  if (!config.decisionLogPath) return undefined
  return new DecisionLog({ path: config.decisionLogPath, cwd: options.cwd, onError: (error) => options.onError?.(error) })
}

/** Plugin entry point. */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = Config.parse(rawConfig ?? {})
  const source = createSource(config)
  const dispatcher = createDispatcher(config, ctx)
  const engine = createEngine(config, {
    dispatcher,
    decisionLog: createDecisionLog(config, { onError: (error) => ctx.logger.error('dsh-patrol decision log write failed: %s', String(error)) }),
    onDecision: (decision) => ctx.logger.info('dsh-patrol decision %s %s (%s)', decision.verdict, decision.threadKey, decision.reason),
  })
  const runner = new PatrolRunner({ source, engine, dispatcher })

  // Publish the packaged skill: the host's filesystem provider only scans workspaces,
  // so a skill shipped inside the plugin has to register itself to be discoverable.
  const skill = readPackagedSkill('dsh-patrol')
  ctx.effect(() => ctx.skills.register({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: 'runtime',
    resourceBase: skillResourceBase(skill),
  }))

  // One round at a time: a slow round must not overlap the next tick, and stopping the plugin
  // waits for the round in flight so no write-back is lost half way.
  let current: Promise<unknown> | null = null
  let ready = false
  const runRound = (): void => {
    current = runner.runOnce()
      .catch((error: unknown) => ctx.logger.error('dsh-patrol round failed: %s', String(error)))
      .then(() => {
        if (ready) return
        ready = true
        ctx.logger.info('dsh-patrol ready: source=%s acceptMode=%s dispatcher=%s', config.kind, config.acceptMode, dispatcher.kind)
      })
  }

  const timer = setInterval(runRound, config.roundIntervalMs)
  timer.unref?.()
  runRound()

  ctx.effect(() => async () => {
    clearInterval(timer)
    if (current) await current
    ctx.logger.info('dsh-patrol stopped')
  })
}

export { Engine } from './core/engine.ts'
export { DecisionLog, resolveDecisionLogPath } from './core/decision-log.ts'
export type { DecisionLogEntry } from './core/decision-log.ts'
export { DirectionPolicy } from './core/policy.ts'
export { BitableSource } from './source/bitable.ts'
export { CodexDispatcher, DshDispatcher, LogDispatcher } from './dispatch.ts'
export { LocalJsonSource } from './source/local-json.ts'
export { PatrolRunner } from './runner.ts'
export { itemToTrigger, itemIsDue } from './mapping.ts'
export { readPackagedSkill } from './skill.ts'
export type { DirectionItem, SourceProvider } from './source/provider.ts'
export type { Ticket, Trigger, Mandate, Assignment } from './core/model.ts'
