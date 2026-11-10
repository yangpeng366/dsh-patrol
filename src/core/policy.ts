/**
 * Policy: versioned admission rules.
 *
 * The Gate is pure code — it decides *who may originate work* and never consults a model.
 * The Assessment is the model's part; it decides *whether this work is worth doing*.
 * Keeping the two apart is the single most transferable idea in the superagent prototype.
 */
import type { Mandate, Strength, Thread, Ticket, Trigger } from './model.ts'

/** One comparable form for a repo path: case, separator and trailing slashes all drop. */
function normaliseRepo(repo: string): string {
  return repo.trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
}

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
  /**
   * Where the row's work lives, exactly as the source wrote it. Only the repo rules read it,
   * and only when the Policy was given an allowlist; without one the field is ignored.
   */
  repoPath?: string
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
  /**
   * Repo prefixes an unattended round may act inside. Empty means "no repo restriction",
   * which is the behaviour every earlier Policy had. Prefixes are compared after
   * normalising separators and case, so `D:/gitAll/openeyes` and `d:\gitall\openeyes` agree.
   */
  readonly autonomousRepos: readonly string[]

  constructor(options: {
    version: string
    paused?: boolean
    inferredRules?: readonly string[]
    evalTimeoutMs?: number
    /** Repo prefixes an unattended round may act inside; empty means no restriction. */
    autonomousRepos?: readonly string[]
  }) {
    this.version = options.version
    this.paused = options.paused ?? false
    this.inferredRules = options.inferredRules ?? ['next-step-present']
    this.evalTimeoutMs = options.evalTimeoutMs ?? 120_000
    this.autonomousRepos = (options.autonomousRepos ?? []).map(normaliseRepo).filter(Boolean)
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

    const repoRefusal = this.refuseRepo(facts)
    if (repoRefusal) return { admissible: false, reason: repoRefusal }

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

  /**
   * The repo-layer refusal, or nothing when the row may proceed.
   *
   * An allowlist is opt-in: with none configured every row keeps the old behaviour. With one,
   * a row that names no repo, names an uncloned repo, or points outside every prefix is refused
   * before it can reach the Assessment. This is the rule that keeps 现场 repositories and rows
   * whose scope is a sentence out of an unattended round.
   */
  private refuseRepo(facts: DirectionFacts): string | undefined {
    if (this.autonomousRepos.length === 0) return undefined
    const raw = String(facts.repoPath ?? '').trim()
    const repo = normaliseRepo(raw)
    if (!repo) return 'no-repo-path'
    if (raw.startsWith('（未克隆）') || raw.startsWith('(未克隆)')) return 'repo-not-cloned'
    const inside = this.autonomousRepos.some((prefix) => repo === prefix || repo.startsWith(`${prefix}\\`))
    return inside ? undefined : 'repo-not-autonomous'
  }

  admitsInferred(rules: readonly string[]): boolean {
    return rules.some((rule) => this.inferredRules.includes(rule))
  }
}
