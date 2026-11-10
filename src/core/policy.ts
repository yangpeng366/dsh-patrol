/**
 * Policy: versioned admission rules.
 *
 * The Gate is pure code — it decides *who may originate work* and never consults a model.
 * The Assessment is the model's part; it decides *whether this work is worth doing*.
 * Keeping the two apart is the single most transferable idea in the superagent prototype.
 */
import type { Mandate, Strength, Thread, Ticket, Trigger } from './model.ts'

/** Gate verdict: inadmissible with a reason, or admissible with a strength and the basis recorded. */
export type GateResult =
  | { admissible: false; reason: string }
  | { admissible: true; strength: Strength; basis: Mandate['basis'] }

/** Versioned rules. Changing the version never revokes a Mandate already granted; it is re-checked on wake-up. */
export interface Policy {
  version: string
  /** A paused Policy admits nothing but keeps every rule for review. */
  paused: boolean
  /** Decides whether a Trigger may originate work. Pure code, no model. */
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-checks a Mandate's gate-layer basis under the current Policy, e.g. before an ended Ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its Assessment matched. */
  admitsInferred(rules: readonly string[]): boolean
  /** How long an Assessment may take before it is recorded as unavailable. */
  evalTimeoutMs: number
}

/** Direction-shaped inputs the Gate needs from a row-shaped source. */
export interface DirectionFacts {
  /** `自主` / `需审批` / `只读` — the source's own authorization column. */
  authorization: string
  /** `sparse` / `dense` / `approve` — the source's own collaboration column. */
  collaboration: string
  /** `待审` / `已通过` / `已忽略` / `阻塞`. */
  approval: string
  /** Priority from the source row. */
  priority: string
  /** Whether the row carries a concrete next action. */
  nextStepPresent: boolean
  /** Whether the row asks for a dry run. */
  fake: boolean
}

/**
 * The Policy we actually run for a direction table.
 *
 * Mapping to the prototype's model:
 *   - `授权边界` decides whether work may start at all and how strong the claim is.
 *   - `协作形态=approve` is the prototype's `accept mode = observe`: the Assessment's verdict is
 *     recorded but not acted on, so a human can review a decision history before opening the gate.
 *   - `审批状态` is a human stop: `已忽略` / `阻塞` refuse work outright.
 */
export class DirectionPolicy implements Policy {
  readonly version: string
  readonly paused: boolean
  /** Rules an inferred candidate may be accepted on, when the collaboration mode allows it. */
  readonly inferredRules: readonly string[]
  readonly evalTimeoutMs: number

  constructor(options: { version: string; paused?: boolean; inferredRules?: readonly string[]; evalTimeoutMs?: number }) {
    this.version = options.version
    this.paused = options.paused ?? false
    this.inferredRules = options.inferredRules ?? ['next-step-present']
    this.evalTimeoutMs = options.evalTimeoutMs ?? 120_000
  }

  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult {
    if (this.paused) return { admissible: false, reason: 'policy-paused' }
    const facts = trigger.meta['facts'] as DirectionFacts | undefined
    if (!facts) return { admissible: false, reason: 'no-direction-facts' }
    if (facts.approval === '已忽略') return { admissible: false, reason: 'approval-ignored' }
    if (facts.approval === '阻塞') return { admissible: false, reason: 'approval-blocked' }
    if (facts.approval === '待审') return { admissible: false, reason: 'approval-pending' }
    if (facts.authorization === '只读') return { admissible: false, reason: 'read-only-direction' }
    if (facts.authorization === '需审批') return { admissible: false, reason: 'needs-approval' }
    if (!facts.nextStepPresent) return { admissible: false, reason: 'no-next-step' }

    const open = tickets.filter((ticket) => ticket.status !== 'ended')
    if (open.length > 0) return { admissible: false, reason: 'ticket-already-open' }

    const strength: Strength = facts.collaboration === 'approve' ? 'inferred' : 'explicit'
    return {
      admissible: true,
      strength,
      basis: { policyVersion: this.version, origin: String(trigger.meta['origin'] ?? thread.key), strength, at: trigger.at },
    }
  }

  revalidate(mandate: Mandate): boolean {
    if (this.paused) return false
    if (mandate.basis.policyVersion === this.version) return true
    // A newer Policy does not revoke a granted Mandate; it only refuses to widen it.
    return mandate.strength === 'explicit'
  }

  admitsInferred(rules: readonly string[]): boolean {
    return rules.some((rule) => this.inferredRules.includes(rule))
  }
}