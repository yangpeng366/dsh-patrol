/**
 * Dispatchers: where a Ticket's work actually goes.
 *
 * The Engine knows nothing about this; it only calls `dispatch`. Three implementations ship:
 * `log` (tests and dry runs), `codex` (the executor this project already runs), and `dsh`
 * (a DSH session, when the host exposes one).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Ticket } from './core/model.ts'

const run = promisify(execFile)

/** What a dispatcher needs besides the Ticket. */
export interface DispatchContext {
  /** The row's own thread id, so an executor can resume. */
  threadId?: string | null
  /** Whether the row asked for a dry run. */
  fake: boolean
  /** Absolute path of the working directory for the work. */
  cwd?: string
}

/** The result of one dispatch attempt. */
export interface DispatchResult {
  ok: boolean
  detail: string
  /** Executor-side session id, when the executor has one. */
  sessionId?: string
}

/** Sends a Ticket's work somewhere. */
export interface Dispatcher {
  readonly kind: string
  dispatch(ticket: Ticket, context: DispatchContext): Promise<DispatchResult>
}

/** The prompt a Ticket turns into. Facts only — the Ticket's scope is the authority. */
export function ticketPrompt(ticket: Ticket): string {
  return [
    `【工单 ${ticket.id}】${ticket.title}`,
    `范围：${ticket.scope}`,
    `阶段：${ticket.stage}`,
    `策略版本：${ticket.mandate.basis.policyVersion}`,
    '',
    '按范围完成一轮有界工作；超时请主动拆分到下一轮，不要拖住整轮。',
    '完成后回报：做了什么、证据在哪、下一步是什么。',
  ].join('\n')
}

/** Writes the work somewhere and forgets about it. Used by tests and dry runs. */
export class LogDispatcher implements Dispatcher {
  readonly kind = 'log'
  readonly seen: Ticket[] = []

  async dispatch(ticket: Ticket): Promise<DispatchResult> {
    this.seen.push(ticket)
    return { ok: true, detail: `logged ${ticket.id}` }
  }
}

/**
 * Runs the work in a `codex exec` child process — the executor this project already uses.
 * Resumes the row's thread when it has one, so a direction keeps its context across rounds.
 */
export class CodexDispatcher implements Dispatcher {
  readonly kind = 'codex'
  private readonly options: { binary?: string; timeoutMs?: number; extraArgs?: string[] }

  constructor(options: { binary?: string; timeoutMs?: number; extraArgs?: string[] } = {}) {
    this.options = options
  }

  async dispatch(ticket: Ticket, context: DispatchContext): Promise<DispatchResult> {
    if (context.fake) return { ok: true, detail: `dry-run ${ticket.id}` }
    const args = ['exec', ...(context.threadId ? ['--resume', context.threadId] : []), ...(this.options.extraArgs ?? []), ticketPrompt(ticket)]
    try {
      const { stdout } = await run(this.options.binary ?? 'codex', args, {
        timeout: this.options.timeoutMs ?? 1_800_000,
        cwd: context.cwd,
        maxBuffer: 32 * 1024 * 1024,
      })
      return { ok: true, detail: stdout.slice(0, 2000) }
    } catch (error) {
      return { ok: false, detail: String((error as Error).message ?? error) }
    }
  }
}

/**
 * The minimal slice of DSH's session controller this plugin uses.
 *
 * Declared structurally on purpose: the real service lives in
 * `@deepseek-ai/dsh-api-session-controller`, whose alpha API moves between releases.
 * Keeping the seam narrow means a DSH upgrade changes one file, not the engine.
 */
export interface DshSessionController {
  prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer'): Promise<unknown>
}

/** Sends the Ticket's work into a DSH session. */
export class DshDispatcher implements Dispatcher {
  readonly kind = 'dsh'
  private readonly controller: DshSessionController

  constructor(controller: DshSessionController) {
    this.controller = controller
  }

  async dispatch(ticket: Ticket, context: DispatchContext): Promise<DispatchResult> {
    const sessionId = context.threadId ?? `patrol-${ticket.id}`
    try {
      await this.controller.prompt(sessionId, `ticket:${ticket.id}`, ticketPrompt(ticket), 'queue')
      return { ok: true, detail: `prompted ${sessionId}`, sessionId }
    } catch (error) {
      return { ok: false, detail: String((error as Error).message ?? error) }
    }
  }
}