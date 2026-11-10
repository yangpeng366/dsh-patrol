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
  verdict: 'ignored' | 'unavailable' | 'admitted' | 'observed'
  reason: string
  /**
   * Where the action verdict came from: the `动作类型` column or the word list. Present whenever the
   * Trigger carries an action fact, so the log answers "written down or inferred" per row.
   */
  actionSource?: ActionSource
  /** Present when the verdict was an accept that was held back for review. */
  wouldAccept?: { title: string; scope: string; rules: string[] }
  ticketId?: string
}

/** The result of one round. */
export interface RoundSummary {
  /** Identifies the round; the same id is on every `DecisionRecord` the round produced. */
  roundId: string
  evaluated: number
  admitted: number
  observed: number
  ignored: number
  unavailable: number
  tickets: string[]
}

export interface EngineOptions {
  policy: Policy
  assessor: Assessor
  /** How accepted verdicts are acted on. */
  acceptMode?: AcceptMode
  /** Clock, injectable for tests. */
  now?: () => Date
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
  private readonly sink: AssignmentSink | undefined
  private readonly onDecision: ((decision: DecisionRecord) => void) | undefined
  /** Counts rounds, so two rounds inside the same millisecond still get distinct ids. */
  private rounds = 0

  constructor(options: EngineOptions) {
    this.policy = options.policy
    this.assessor = options.assessor
    this.acceptMode = options.acceptMode ?? 'auto'
    this.now = options.now ?? (() => new Date())
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

  /** Runs one Evaluation round over every pending Trigger, grouped by thread. */
  async runRound(now: Date = this.now()): Promise<RoundSummary> {
    const roundId = this.nextRoundId(now)
    const summary: RoundSummary = { roundId, evaluated: 0, admitted: 0, observed: 0, ignored: 0, unavailable: 0, tickets: [] }
    for (const trigger of this.pending()) {
      // Another round may have judged this Trigger while this one awaited the Assessor. Its
      // disposition is the record then; judging it again would open a second line of work.
      if (this.dispositions.get(trigger.id)?.state !== 'pending') continue
      const thread = this.threads.get(trigger.threadKey)!
      // The Thread's whole Trigger set is the Assessment's context; every pending Trigger is judged.
      const threadTriggers = thread.triggerIds.map((id) => this.triggers.get(id)).filter((t): t is Trigger => t !== undefined)
      const evalId = `eval_${createHash('sha1').update(trigger.id).digest('hex').slice(0, 12)}`

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
      ...extra, ticketId,
    })
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

/** Scope helper re-exported for callers that only import the Engine. */
export { itemScope }
