/**
 * The Engine: Trigger in, Ticket out.
 *
 * It owns the parts the prototype calls the domain: threads, dispositions, tickets, assignments.
 * It does not own IO — sources feed it, an executor receives its assignments, and the model
 * only ever sees bounded facts through the Assessor.
 */
import type { AcceptMode, Assessor, Candidate } from './eval.ts'
import type { ActionSource } from './action-facts.ts'
import type { Assignment, Mandate, Strength, Thread, Ticket, TicketEndBy, Trigger, TriggerDisposition } from './model.ts'
import type { Policy } from './policy.ts'
import { itemScope } from '../mapping.ts'
import { createHash } from 'node:crypto'

/** Why a `stopped` log line exists. Row identity fields stay the same for every event. */
export type StoppedEvent = 'snapshot' | 'added' | 'removed' | 'heartbeat'

/** Twelve hours: stable wall-clock freshness even when `roundIntervalMs` changes. */
const DEFAULT_STOPPED_HEARTBEAT_MS = 12 * 60 * 60 * 1000

interface StoppedRowState {
  /** `recordId` when supplied; the thread key is the stable fallback. */
  key: string
  trigger: Trigger
  recordId?: string
  intervalMin?: number
  /** When this process first saw the row stopped; a restart rebases it to the snapshot time. */
  stoppedSince: string
}

/** Where a started Assignment goes. */
export interface AssignmentSink {
  start(ticket: Ticket, assignment: Assignment): void | Promise<void>
}

/** What the Engine decided about one Evaluation. */
export interface DecisionRecord {
  /** Round this decision belongs to; stable across every decision of one `runRound`. */
  roundId: string
  evalId: string
  threadKey: string
  triggerId: string
  /**
   * `stopped` is the one verdict the Engine reaches without judging the row: its schedule is
   * stopped (巡检间隔 0/空), so it never enters the Gate's assessment path. The record exists so
   * "which rows are stopped, and why did nothing run" stays answerable from the log.
   */
  verdict: 'ignored' | 'unavailable' | 'admitted' | 'observed' | 'stopped'
  reason: string
  /**
   * Where the action verdict came from: the `动作类型` column or the word list. Present whenever the
   * Trigger carries an action fact, so the log answers "written down or inferred" per row.
   */
  actionSource?: ActionSource
  /**
   * The source row's own id (`patrol:<recordId>` is the thread key). Carried so a log reader does
   * not have to parse `triggerId` to answer "which row was this".
   */
  recordId?: string
  /**
   * The row's `巡检间隔(分钟)` as the source wrote it, with `0` meaning 停跑. The value, not a
   * reading of it: a `stopped` record says `0` here, a running row says its real interval.
   */
  intervalMin?: number
  /**
   * A `stopped` line is either a row-state event or the periodic set heartbeat. `removed`
   * means the row left the stopped set; the verdict still names the state family the line is
   * about, while `recordId` names the row that resumed.
   */
  stoppedEvent?: StoppedEvent
  /** Number of rows in the stopped set after this event. */
  stoppedCount?: number
  /** Stable digest of the sorted `recordId + intervalMin` set, never of the clock. */
  stoppedFingerprint?: string
  /** First observation of this stopped row, ISO; a lower bound across process restarts. */
  stoppedSince?: string
  /** Present when the verdict was an accept that was held back for review. */
  wouldAccept?: { title: string; scope: string; rules: string[] }
  ticketId?: string
}

/** What one `runRound` was told about the rows it will not judge. */
export interface RoundInput {
  /**
   * Rows whose schedule is stopped (巡检间隔 0/空). Deliberately *not* received as pending
   * Triggers: they get a `stopped` record and a count, and never touch the Assessor.
   */
  stopped?: readonly Trigger[]
}

/** The result of one round. */
export interface RoundSummary {
  /** Identifies the round; the same id is on every `DecisionRecord` the round produced. */
  roundId: string
  /** Triggers the Gate and the Assessor actually judged. `stopped` rows are not counted here. */
  evaluated: number
  admitted: number
  observed: number
  ignored: number
  unavailable: number
  /** Rows whose schedule is stopped this round: visible, never assessed, never dispatched. */
  stopped: number
  tickets: string[]
}

export interface EngineOptions {
  policy: Policy
  assessor: Assessor
  /** How accepted verdicts are acted on. */
  acceptMode?: AcceptMode
  /** Clock, injectable for tests. */
  now?: () => Date
  /** How often an unchanged stopped set gets one heartbeat line. Defaults to 12 hours. */
  stoppedHeartbeatMs?: number
  sink?: AssignmentSink
  onDecision?: (decision: DecisionRecord) => void
}

export class Engine {
  private readonly triggers = new Map<string, Trigger>()
  private readonly dispositions = new Map<string, TriggerDisposition>()
  private readonly threads = new Map<string, Thread>()
  private readonly ticketStore = new Map<string, Ticket>()
  private readonly policy: Policy
  private readonly assessor: Assessor
  private readonly acceptMode: AcceptMode
  private readonly now: () => Date
  private readonly stoppedHeartbeatMs: number
  private readonly sink: AssignmentSink | undefined
  private stoppedRows = new Map<string, StoppedRowState>()
  private stoppedSnapshotDone = false
  private stoppedHeartbeatAt = 0
  private readonly onDecision: ((decision: DecisionRecord) => void) | undefined
  /** Counts rounds, so two rounds inside the same millisecond still get distinct ids. */
  private rounds = 0

  constructor(options: EngineOptions) {
    this.policy = options.policy
    this.assessor = options.assessor
    this.acceptMode = options.acceptMode ?? 'auto'
    this.now = options.now ?? (() => new Date())
    this.stoppedHeartbeatMs = options.stoppedHeartbeatMs ?? DEFAULT_STOPPED_HEARTBEAT_MS
    this.sink = options.sink
    this.onDecision = options.onDecision
  }

  /** Accepts a Trigger. A Trigger already seen is a duplicate and changes nothing. */
  receive(trigger: Trigger): boolean {
    if (this.dispositions.has(trigger.id)) return false
    this.triggers.set(trigger.id, trigger)
    const thread = this.threads.get(trigger.threadKey) ?? { key: trigger.threadKey, source: trigger.source, triggerIds: [] }
    if (!thread.triggerIds.includes(trigger.id)) thread.triggerIds.push(trigger.id)
    this.threads.set(trigger.threadKey, thread)
    this.dispositions.set(trigger.id, { state: 'pending' })
    return true
  }

  /** Triggers that no Evaluation has judged yet. */
  pending(): Trigger[] {
    return [...this.triggers.values()].filter((trigger) => this.dispositions.get(trigger.id)?.state === 'pending')
  }

  /** Every Ticket, open or ended. */
  tickets(): Ticket[] {
    return [...this.ticketStore.values()]
  }

  ticket(id: string): Ticket | undefined {
    return this.ticketStore.get(id)
  }

  /** Ends a Ticket; an ended Ticket keeps its record but takes no new work. */
  endTicket(id: string, by: TicketEndBy, outcome: TicketEndBy = by): Ticket | undefined {
    const ticket = this.ticketStore.get(id)
    if (!ticket || ticket.status === 'ended') return ticket
    ticket.status = 'ended'
    ticket.endedAt = this.now().toISOString()
    ticket.outcome = outcome
    for (const assignment of ticket.assignments) {
      if (assignment.status !== 'ended') { assignment.status = 'ended'; assignment.endedAt = ticket.endedAt }
    }
    return ticket
  }

  /**
   * Runs one Evaluation round over every pending Trigger, grouped by thread.
   *
   * `input.stopped` carries the rows the caller deliberately kept out of the due set because their
   * schedule is stopped. They are recorded first — "why did nothing run" is the round's first
   * answer — and then never judged: no Gate, no Assessment, no Ticket.
   */
  async runRound(now: Date = this.now(), input: RoundInput = {}): Promise<RoundSummary> {
    const roundId = this.nextRoundId(now)
    const summary: RoundSummary = { roundId, evaluated: 0, admitted: 0, observed: 0, ignored: 0, unavailable: 0, stopped: 0, tickets: [] }
    this.recordStoppedSet(now, roundId, input.stopped ?? [], summary)
    for (const trigger of this.pending()) {
      // Another round may have judged this Trigger while this one awaited the Assessor. Its
      // disposition is the record then; judging it again would open a second line of work.
      if (this.dispositions.get(trigger.id)?.state !== 'pending') continue
      const thread = this.threads.get(trigger.threadKey)!
      // The Thread's whole Trigger set is the Assessment's context; every pending Trigger is judged.
      const threadTriggers = thread.triggerIds.map((id) => this.triggers.get(id)).filter((t): t is Trigger => t !== undefined)
      const evalId = evalIdOf(trigger.id)

      const gate = this.policy.gate(trigger, thread, this.tickets())
      if (!gate.admissible) {
        this.decide(trigger, roundId, evalId, 'ignored', gate.reason, summary)
        continue
      }

      const candidate: Candidate = {
        evalId,
        thread,
        triggers: threadTriggers,
        strength: gate.strength,
        policyVersion: this.policy.version,
        tickets: this.tickets().filter((ticket) => ticket.threadKey === trigger.threadKey),
      }

      const outcome = await this.assessor.assess(candidate)
      if (outcome.kind === 'ignore') { this.decide(trigger, roundId, evalId, 'ignored', outcome.reason, summary); continue }
      if (outcome.kind === 'unavailable') { this.decide(trigger, roundId, evalId, 'unavailable', outcome.reason, summary); continue }
      if (outcome.kind === 'stop') {
        this.endTicket(outcome.ticketId, 'person', 'dropped')
        this.decide(trigger, roundId, evalId, 'ignored', outcome.reason, summary)
        continue
      }

      const rules = outcome.rules ?? []
      const held = this.holds(gate.strength, rules)
      if (held) {
        this.decide(trigger, roundId, evalId, 'observed', `held-by-mode:${this.acceptMode}`, summary, {
          wouldAccept: { title: outcome.title, scope: outcome.scope, rules },
        })
        continue
      }

      // The Assessor was awaited: the ticket set may have changed since the Gate ran. Re-run the
      // Gate against the tickets as they are *now*, with no await before the open below, so two
      // rounds racing on the same repo cannot both open a Ticket for it.
      const commit = this.policy.gate(trigger, thread, this.tickets())
      if (!commit.admissible) {
        this.decide(trigger, roundId, evalId, 'ignored', commit.reason, summary)
        continue
      }

      const ticket = this.openTicket(trigger, commit.strength, commit.basis, outcome.title, outcome.scope)
      this.decide(trigger, roundId, evalId, 'admitted', outcome.reason, summary, undefined, ticket.id)
      summary.tickets.push(ticket.id)
    }
    return summary
  }

  /**
   * Whether an accept verdict is held back for review.
   *
   * `off` and `observe` start nothing at all: `observe` records what would have been accepted and
   * why, so a human can read the decision history before opening the gate. `auto` starts explicit
   * work and starts inferred work only on the rules the Policy admits.
   */
  private holds(strength: Strength, rules: string[]): boolean {
    if (this.acceptMode !== 'auto') return true
    if (strength === 'inferred') return !this.policy.admitsInferred(rules)
    return false
  }

  /** `rnd_<ISO basic>Z_<n>`: readable, sortable, and unique within the process. */
  private nextRoundId(now: Date): string {
    this.rounds += 1
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    return `rnd_${stamp}_${this.rounds}`
  }

  private decide(
    trigger: Trigger,
    roundId: string,
    evalId: string,
    verdict: DecisionRecord['verdict'],
    reason: string,
    summary: RoundSummary,
    extra?: { wouldAccept?: DecisionRecord['wouldAccept'] },
    ticketId?: string,
  ): void {
    this.dispositions.set(trigger.id, { state: 'evaluated', decision: verdict })
    summary.evaluated += 1
    if (verdict === 'admitted') summary.admitted += 1
    else if (verdict === 'observed') summary.observed += 1
    else if (verdict === 'unavailable') summary.unavailable += 1
    else summary.ignored += 1
    this.onDecision?.({
      roundId, evalId, threadKey: trigger.threadKey, triggerId: trigger.id, verdict, reason,
      // The source marker is a property of the row, not of the verdict: a refused and an accepted
      // row both say whether their kind was written in the table or inferred from prose.
      actionSource: actionSourceOf(trigger),
      ...this.rowOf(trigger),
      ...extra, ticketId,
    })
  }

  /**
   * Records the stopped set as a small state machine: a full snapshot on the first round, then
   * one line per added/removed row, and one heartbeat while the set is unchanged. Every line keeps
   * the Policy's own `schedule-stopped` reason; no Gate, Assessor or Ticket is involved.
   */
  private recordStoppedSet(now: Date, roundId: string, triggers: readonly Trigger[], summary: RoundSummary): void {
    const current = new Map<string, StoppedRowState>()
    for (const trigger of triggers) {
      const row = this.stoppedStateOf(trigger, now)
      current.set(row.key, row)
    }
    const count = current.size
    const fingerprint = stoppedFingerprintOf(current.values())
    summary.stopped = count
    for (const row of current.values()) {
      this.dispositions.set(row.trigger.id, { state: 'evaluated', decision: 'stopped' })
    }

    if (!this.stoppedSnapshotDone) {
      this.stoppedSnapshotDone = true
      const rows = sortedStoppedRows(current.values())
      for (const row of rows) this.emitStoppedRow(row, 'snapshot', roundId, count, fingerprint)
      this.stoppedRows = current
      this.stoppedHeartbeatAt = now.getTime()
      return
    }

    const added = sortedStoppedRows([...current.values()].filter((row) => !this.stoppedRows.has(row.key)))
    const removed = sortedStoppedRows([...this.stoppedRows.values()].filter((row) => !current.has(row.key)))
    this.stoppedRows = current
    if (added.length > 0 || removed.length > 0) {
      for (const row of added) this.emitStoppedRow(row, 'added', roundId, count, fingerprint)
      for (const row of removed) this.emitStoppedRow(row, 'removed', roundId, count, fingerprint)
      this.stoppedHeartbeatAt = now.getTime()
      return
    }

    if (count > 0 && now.getTime() - this.stoppedHeartbeatAt >= this.stoppedHeartbeatMs) {
      this.emitStoppedHeartbeat(roundId, count, fingerprint)
      this.stoppedHeartbeatAt = now.getTime()
    }
  }

  /** A row already in the set keeps its first-seen time; a new one starts at this round. */
  private stoppedStateOf(trigger: Trigger, now: Date): StoppedRowState {
    const row = this.rowOf(trigger)
    const key = row.recordId ?? trigger.threadKey
    const stoppedSince = this.stoppedRows.get(key)?.stoppedSince ?? now.toISOString()
    return { key, trigger, ...row, stoppedSince }
  }

  private emitStoppedRow(
    row: StoppedRowState,
    event: Exclude<StoppedEvent, 'heartbeat'>,
    roundId: string,
    count: number,
    fingerprint: string,
  ): void {
    this.onDecision?.({
      roundId,
      evalId: evalIdOf(row.trigger.id),
      threadKey: row.trigger.threadKey,
      triggerId: row.trigger.id,
      verdict: 'stopped',
      reason: 'schedule-stopped',
      actionSource: actionSourceOf(row.trigger),
      ...this.rowOf(row.trigger),
      stoppedEvent: event,
      stoppedCount: count,
      stoppedFingerprint: fingerprint,
      stoppedSince: row.stoppedSince,
    })
  }

  private emitStoppedHeartbeat(
    roundId: string,
    count: number,
    fingerprint: string,
  ): void {
    this.onDecision?.({
      roundId,
      evalId: 'eval_stopped_set',
      threadKey: 'stopped-set',
      triggerId: 'stopped-set',
      verdict: 'stopped',
      reason: 'schedule-stopped',
      stoppedEvent: 'heartbeat',
      stoppedCount: count,
      stoppedFingerprint: fingerprint,
    })
  }

  /** The row identity a decision carries: record id and the interval exactly as the source wrote it. */
  private rowOf(trigger: Trigger): { recordId?: string; intervalMin?: number } {
    const itemId = trigger.meta['itemId']
    const facts = trigger.meta['facts'] as { intervalMin?: unknown } | undefined
    const interval = facts?.intervalMin
    const row: { recordId?: string; intervalMin?: number } = {}
    if (typeof itemId === 'string' && itemId !== '') row.recordId = itemId
    if (typeof interval === 'number' && Number.isFinite(interval)) row.intervalMin = interval
    return row
  }

  private openTicket(
    trigger: Trigger,
    strength: Strength,
    basis: Mandate['basis'],
    title: string,
    scope: string,
  ): Ticket {
    // `ticketStore` keeps ended Tickets, so a row that opens again after its Ticket ended must
    // not overwrite the record of the previous generation: a second line of work gets `-r2`.
    const baseId = `tkt_${createHash('sha1').update(trigger.threadKey).digest('hex').slice(0, 12)}`
    let id = baseId
    for (let generation = 2; this.ticketStore.has(id); generation += 1) id = `${baseId}-r${generation}`
    const mandate: Mandate = { scope, strength, basis }
    const assignment: Assignment = { id: `asg_${createHash('sha1').update(`${id}:${trigger.id}`).digest('hex').slice(0, 12)}`, ticketId: id, status: 'pending' }
    const repoPath = trigger.meta['repoPath']
    const ticket: Ticket = {
      id,
      threadKey: trigger.threadKey,
      title,
      scope,
      repoPath: typeof repoPath === 'string' ? repoPath : undefined,
      status: 'open',
      mandate,
      assignments: [assignment],
      subscription: { threadKey: trigger.threadKey, dropped: false },
      stage: String(trigger.meta['stage'] ?? '探索'),
      createdAt: this.now().toISOString(),
      sourceItemId: String(trigger.meta['itemId'] ?? trigger.threadKey.replace(/^patrol:/, '')),
    }
    this.ticketStore.set(id, ticket)
    assignment.status = 'running'
    assignment.startedAt = this.now().toISOString()
    ticket.status = 'running'
    void this.sink?.start(ticket, assignment)
    return ticket
  }
}

/**
 * The action-kind source a Trigger carries, if any.
 *
 * `itemToTrigger()` writes the fact in two places (`meta.facts.actionFacts` for the Gate and
 * `meta.actionFacts` for readers); a Trigger built by hand in a test may carry only one of them.
 * Neither present means the caller never classified the row, and the log says nothing.
 */
function actionSourceOf(trigger: Trigger): ActionSource | undefined {
  const facts = trigger.meta['facts'] as { actionFacts?: { source?: ActionSource } } | undefined
  const direct = trigger.meta['actionFacts'] as { source?: ActionSource } | undefined
  return facts?.actionFacts?.source ?? direct?.source
}

/** Stable order for log lines and the digest: row identity, never input order or wall-clock time. */
function sortedStoppedRows(rows: Iterable<StoppedRowState>): StoppedRowState[] {
  return [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

function stoppedFingerprintOf(rows: Iterable<StoppedRowState>): string {
  const material = sortedStoppedRows(rows)
    .map((row) => `${row.key}\u0000${row.intervalMin ?? ''}`)
    .join('\n')
  return createHash('sha256').update(material).digest('hex')
}

/** One row's Evaluation id: derived from the Trigger id, so a re-judged row keeps its name. */
function evalIdOf(triggerId: string): string {
  return `eval_${createHash('sha1').update(triggerId).digest('hex').slice(0, 12)}`
}

/** Scope helper re-exported for callers that only import the Engine. */
export { itemScope }
