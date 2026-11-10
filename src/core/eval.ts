/**
 * Eval: the two-layer admission step.
 *
 * Gate (pure code) already passed; now a bounded judgement decides whether the work is worth doing.
 * The Assessment sees facts only — never authority. The Mandate is granted by the Engine afterwards.
 */
import type { Strength, Thread, Ticket, Trigger } from './model.ts'

/** What the Assessment concluded. */
export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'accept'; title: string; scope: string; reason: string; rules?: string[]; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string }

/** The bounded facts an Assessment may read. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every Ticket on the thread, ended ones included, so duplicates can be judged. */
  tickets: Ticket[]
}

/** The model side of Eval. */
export interface Assessor {
  assess(candidate: Candidate, signal?: AbortSignal): Promise<AssessmentOutcome>
}

/** How a verdict is acted on. */
export type AcceptMode =
  /** Inferred verdicts are never acted on. */
  | 'off'
  /** Verdicts are recorded as `would accept` but nothing starts — a reviewable decision history. */
  | 'observe'
  /** Verdicts start work. */
  | 'auto'

/**
 * An Assessor built from a plain function, with a timeout and a mode gate.
 * Used for the deterministic (non-model) path and in tests.
 */
export class FunctionAssessor implements Assessor {
  private readonly fn: (candidate: Candidate) => Promise<AssessmentOutcome> | AssessmentOutcome
  private readonly timeoutMs: number
  private readonly mode: AcceptMode

  constructor(fn: (candidate: Candidate) => Promise<AssessmentOutcome> | AssessmentOutcome, options: { timeoutMs?: number; mode?: AcceptMode } = {}) {
    this.fn = fn
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.mode = options.mode ?? 'auto'
  }

  get acceptMode(): AcceptMode {
    return this.mode
  }

  async assess(candidate: Candidate, signal?: AbortSignal): Promise<AssessmentOutcome> {
    const work = Promise.resolve(this.fn(candidate))
    const timer = new Promise<AssessmentOutcome>((resolve) => {
      const handle = setTimeout(() => resolve({ kind: 'unavailable', reason: 'assessment-timeout' }), this.timeoutMs)
      handle.unref?.()
    })
    try {
      return await Promise.race([work, timer])
    } finally {
      signal?.throwIfAborted()
    }
  }
}