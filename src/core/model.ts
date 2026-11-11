/**
 * Core domain types for dsh-patrol.
 *
 * These follow the superagent research prototype's domain model (Trigger / Thread / Mandate / Ticket /
 * Assignment), but are rewritten small enough to read in one sitting and to depend on nothing.
 * The prototype's model is MIT (DeepSeek Harness Team); the shape is credited in docs/001-domain.md.
 */

/** How strong a Trigger's claim on the agent's attention is. `explicit` may start work; `inferred` may only be a candidate. */
export type Strength = 'explicit' | 'inferred'

/** A Ticket's lifecycle. `waiting` means the work is blocked on a person, not on the executor. */
export type TicketStatus = 'open' | 'running' | 'waiting' | 'ended'

/** An Assignment binds a Ticket to one executor run. */
export type AssignmentStatus = 'pending' | 'running' | 'ended'

/** Why a Ticket ended. */
export type TicketEndBy = 'complete' | 'blocked' | 'person' | 'policy' | 'dropped'

/** An immutable event. A Trigger is the smallest unit of audit and idempotency. */
export interface Trigger {
  /** Stable, content-addressed id: the same row state must never produce two different ids. */
  id: string
  /** Which source produced it, e.g. `bitable` or `local-json`. */
  source: string
  /** Threads group Triggers that belong to one unit of work. */
  threadKey: string
  /** ISO timestamp of the event. */
  at: string
  strength: Strength
  /** Bounded facts about the event. Never authority — authority lives in the Mandate. */
  meta: Record<string, unknown>
}

/** A time-ordered series of Triggers, grouped by the Source. */
export interface Thread {
  key: string
  source: string
  triggerIds: string[]
}

/** The recorded basis on which authority was granted. A Mandate never widens in place. */
export interface MandateBasis {
  /** Policy version in force when the Mandate was granted. */
  policyVersion: string
  /** Who or what originated the work, e.g. `row:recZZZ` or `human`. */
  origin: string
  strength: Strength
  at: string
}

/** A grant of authority: what may be done, how strongly, and on whose authority. */
export interface Mandate {
  /** What the work is allowed to touch. */
  scope: string
  strength: Strength
  basis: MandateBasis
}

/** One executor run of a Ticket. A Ticket may have several over its life. */
export interface Assignment {
  id: string
  ticketId: string
  status: AssignmentStatus
  startedAt?: string
  endedAt?: string
  /** Executor-side session id, when the executor is session-based. */
  sessionId?: string
}

/** A unit of authorized work. Its state does not follow the executor; the executor follows it. */
export interface Ticket {
  id: string
  threadKey: string
  title: string
  /** What this Ticket is allowed to do. */
  scope: string
  /**
   * The repo this Ticket was opened for, exactly as the Trigger carried it.
   * `ticket-already-open` is decided per repo, so this field is what keeps one repo from
   * becoming two lines of work while leaving other repos free to run in parallel.
   */
  repoPath?: string
  status: TicketStatus
  mandate: Mandate
  assignments: Assignment[]
  /** Fan-out delivery context. A dropped subscription keeps the Ticket but stops new context. */
  subscription: { threadKey: string; dropped: boolean }
  /** Where the work stands, e.g. `开发` / `维护` / `验证`. */
  stage: string
  createdAt: string
  endedAt?: string
  outcome?: TicketEndBy
  /** The source row this Ticket came from, so results can be written back. */
  sourceItemId: string
}

/** What happened to a Trigger after it was received. */
export type TriggerDisposition =
  | { state: 'pending' }
  | { state: 'evaluated'; decision: 'ignored' | 'unavailable' | 'admitted' | 'observed' | 'stopped' }
  | { state: 'duplicate' }