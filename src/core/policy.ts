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
  /**
   * The row's own `巡检间隔(分钟)`, exactly as the source wrote it: a positive number of minutes,
   * or `0` when the cell is 0/blank. The table's `巡检占用` column spells the convention out
   * ("0=禁用巡检", and resuming means writing a real interval back), so 0 is a stopped row, not
   * "every round". Missing is read the same way as 0 — see `schedule-stopped` below.
   */
  intervalMin?: number
  /** Whether the row asks for a dry run. */
  fake: boolean
  /**
   * Where the row's work lives, exactly as the source wrote it. Only the repo rules read it,
   * and they read it on every unattended round: v3 refuses a row whose repo is not on the
   * allowlist, including the case where no allowlist was configured at all.
   */
  repoPath?: string
}

/**
 * The Policy we actually run for a direction table.
 *
 * Mapping to the prototype's model:
 *   - `授权边界` decides whether work may start at all and how strong the claim is.
 *   - `巡检间隔(分钟)` decides whether the row is running at all: 0/blank is 停跑 (v4).
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
   * Repo prefixes an unattended round may act inside. Empty is a refusal, not a wildcard:
   * since Policy v3 an unset allowlist refuses every row with `repo-allowlist-unset`.
   * Prefixes are compared after normalising separators and case, so `D:/gitAll/openeyes`
   * and `d:\gitall\openeyes` agree.
   */
  readonly autonomousRepos: readonly string[]
  /**
   * Explicit opt-in to the pre-v3 "any repo" rule, for interactive callers and unit tests.
   * It is never inferred from an empty `autonomousRepos`: forgetting to configure an allowlist
   * must not mean "all repos allowed" — that fail-open default is exactly what v3 removes.
   */
  readonly allowAnyRepo: boolean

  constructor(options: {
    version: string
    paused?: boolean
    inferredRules?: readonly string[]
    evalTimeoutMs?: number
    /** Repo prefixes an unattended round may act inside; empty refuses every row. */
    autonomousRepos?: readonly string[]
    /** Opt in to the old "any repo" rule. Defaults to false and is never implied by an empty list. */
    allowAnyRepo?: boolean
  }) {
    this.version = options.version
    this.paused = options.paused ?? false
    this.inferredRules = options.inferredRules ?? ['next-step-present']
    this.evalTimeoutMs = options.evalTimeoutMs ?? 120_000
    this.autonomousRepos = (options.autonomousRepos ?? []).map(normaliseRepo).filter(Boolean)
    this.allowAnyRepo = options.allowAnyRepo ?? false
  }

  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult {
    if (this.paused) return { admissible: false, reason: 'policy-paused' }
    const facts = trigger.meta['facts'] as DirectionFacts | undefined
    if (!facts) return { admissible: false, reason: 'no-direction-facts' }
    // Policy v4 reads the row's schedule before anything else: a stopped row produces no work
    // whatever its approval state says, and "why did nothing run" has exactly one first answer.
    if (this.isStopped(facts)) return { admissible: false, reason: 'schedule-stopped' }
    if (facts.approval === '已忽略') return { admissible: false, reason: 'approval-ignored' }
    if (facts.approval === '阻塞') return { admissible: false, reason: 'approval-blocked' }
    if (facts.approval === '待审') return { admissible: false, reason: 'approval-pending' }
    if (facts.authorization === '只读') return { admissible: false, reason: 'read-only-direction' }
    if (facts.authorization === '需审批') return { admissible: false, reason: 'needs-approval' }
    if (!facts.nextStepPresent) return { admissible: false, reason: 'no-next-step' }

    const repo = normaliseRepo(String(facts.repoPath ?? ''))
    const repoRefusal = this.refuseRepo(facts, repo)
    if (repoRefusal) return { admissible: false, reason: repoRefusal }

    // One open Ticket per **repo**, not one per process: a direction table can hold several rows
    // that point at the same repo, and those are exactly the rows that must not become two lines
    // of work. Rows pointing at other repos are untouched by this check.
    if (tickets.some((ticket) => this.holdsRepo(ticket, repo, thread.key))) {
      return { admissible: false, reason: 'ticket-already-open' }
    }

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
   * Whether the row's own schedule says it is stopped (Policy v4).
   *
   * `巡检间隔(分钟)` is the one structured fact the v3 gate never read, and the one the observed
   * round got wrong: 56 of the 68 would-accept rows in the 2026-11-10 log carry 0 or a blank cell,
   * which the table's own `巡检占用` column defines as 停跑 (`docs/policy-v4-triage.md` §2). Reading
   * it as "due every round" is what put rows nothing was expected from into the accept set.
   *
   * A missing fact is refused too, and not because the row is known to be stopped: an unstated
   * schedule is a forgotten setting, and v3 already established that a forgotten setting is not a
   * permission (`repo-allowlist-unset`). The two refusals share one rule, not two.
   */
  private isStopped(facts: DirectionFacts): boolean {
    const interval = facts.intervalMin
    return typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0
  }

  /**
   * The repo-layer refusal, or nothing when the row may proceed.
   *
   * Policy v3 is fail-closed: no allowlist means no unattended work, never "any repo". A row that
   * names no repo, names an uncloned repo, or points outside every configured prefix is refused
   * before it can reach the Assessment. This is the rule that keeps 现场 repositories, release
   * rows and rows whose scope is a sentence out of an unattended round.
   *
   * `allowAnyRepo` is the only way back to the pre-v3 behaviour, and it has to be written down by
   * the caller. An empty array must not be a bypass: `[]` is what a forgotten setting looks like,
   * so treating it as "all repos" is precisely the fail-open default this version removes.
   */
  private refuseRepo(facts: DirectionFacts, repo: string): string | undefined {
    if (this.allowAnyRepo) return undefined
    if (this.autonomousRepos.length === 0) return 'repo-allowlist-unset'
    const raw = String(facts.repoPath ?? '').trim()
    if (!repo) return 'no-repo-path'
    if (raw.startsWith('（未克隆）') || raw.startsWith('(未克隆)')) return 'repo-not-cloned'
    const inside = this.autonomousRepos.some((prefix) => repo === prefix || repo.startsWith(`${prefix}\\`))
    return inside ? undefined : 'repo-not-autonomous'
  }

  /**
   * Whether an open Ticket already holds this repo.
   *
   * Tickets record the repo they were opened for; an ended Ticket holds nothing. A Ticket that
   * predates `repoPath` cannot be attributed to a repo, so it blocks the thread it belongs to —
   * and, when it has no thread either, it blocks everything: an unattributable open Ticket must
   * never be the hole through which a second line opens.
   */
  private holdsRepo(ticket: Ticket, repo: string, threadKey: string): boolean {
    if (ticket.status === 'ended') return false
    const ticketRepo = normaliseRepo(String(ticket.repoPath ?? ''))
    if (ticketRepo) return ticketRepo === repo
    return typeof ticket.threadKey !== 'string' || ticket.threadKey === threadKey
  }

  admitsInferred(rules: readonly string[]): boolean {
    return rules.some((rule) => this.inferredRules.includes(rule))
  }
}
