import { describe, expect, it } from 'vitest'
import { DirectionPolicy } from '../src/core/policy.ts'
import type { ActionFacts } from '../src/core/action-facts.ts'
import type { RepoExistsFact } from '../src/core/repo-facts.ts'
import type { Thread, Ticket, Trigger } from '../src/core/model.ts'

const thread: Thread = { key: 'patrol:rec1', source: 'direction-table', triggerIds: ['trg1'] }

/** The fact `itemRepoFact()` produces for a real directory; the Gate refuses a row without one. */
function repoFact(overrides: Partial<RepoExistsFact> = {}): RepoExistsFact {
  return {
    raw: 'D:\\gitAll\\dsh-patrol',
    exists: true,
    kind: 'directory',
    normalizedPath: 'D:\\gitAll\\dsh-patrol',
    reason: 'repo-exists-ok',
    candidates: [],
    ...overrides,
  }
}

/** The fact `itemActionFact()` produces for a next step that is repo work. */
function actionFact(overrides: Partial<ActionFacts> = {}): ActionFacts {
  return {
    kind: 'repo-code',
    // The default fact is the pre-column one: inferred from prose. A column fact says `column`.
    source: 'text',
    matched: ['实现'],
    evidence: '把下一步做完',
    field: '下一步',
    reason: '「下一步」里是仓内可做的动作',
    alternatives: [],
    ...overrides,
  }
}

function trigger(overrides: Record<string, unknown> = {}): Trigger {
  return {
    id: 'trg1',
    source: 'direction-table',
    threadKey: thread.key,
    at: '2026-11-10T00:00:00.000Z',
    strength: 'explicit',
    meta: {
      origin: 'row:rec1',
      facts: {
        authorization: '自主',
        collaboration: 'sparse',
        approval: '已通过',
        priority: 'P1',
        fake: false,
        nextStepPresent: true,
        // A running row: `巡检间隔(分钟)` > 0. Policy v4 refuses anything without one.
        intervalMin: 60,
        // The repo layer needs the probed cell too; `repo-exists-unknown` is a refusal.
        repoExists: repoFact(),
        // And the action layer: repo work is what an unattended round may do.
        actionFacts: actionFact(),
      },
      ...overrides,
    },
  }
}

function facts(overrides: Record<string, unknown>): Trigger {
  const base = trigger().meta['facts'] as Record<string, unknown>
  return trigger({ facts: { ...base, ...overrides } })
}

describe('DirectionPolicy.gate', () => {
  // The non-repo rules are exercised behind the explicit opt-in, so each test hits its own layer
  // instead of being masked by the v3 repo default. The repo layer has its own describe below.
  const policy = new DirectionPolicy({ version: 'v1', allowAnyRepo: true })

  it('admits a 自主 row with a next step as explicit work', () => {
    const result = policy.gate(trigger(), thread, [])
    expect(result.admissible).toBe(true)
    if (result.admissible) {
      expect(result.strength).toBe('explicit')
      expect(result.basis.policyVersion).toBe('v1')
      expect(result.basis.origin).toBe('row:rec1')
    }
  })

  it('treats 协作形态=approve as inferred, never as explicit', () => {
    const result = policy.gate(facts({ collaboration: 'approve' }), thread, [])
    expect(result.admissible).toBe(true)
    if (result.admissible) expect(result.strength).toBe('inferred')
  })

  it('refuses rows that need approval or are read-only', () => {
    expect(policy.gate(facts({ authorization: '需审批' }), thread, []).admissible).toBe(false)
    expect(policy.gate(facts({ authorization: '只读' }), thread, []).admissible).toBe(false)
  })

  it('refuses rows whose approval state is not 已通过', () => {
    expect(policy.gate(facts({ approval: '待审' }), thread, []).admissible).toBe(false)
    expect(policy.gate(facts({ approval: '已忽略' }), thread, []).admissible).toBe(false)
    expect(policy.gate(facts({ approval: '阻塞' }), thread, []).admissible).toBe(false)
  })

  it('refuses a row with no concrete next step', () => {
    expect(policy.gate(facts({ nextStepPresent: false }), thread, []).admissible).toBe(false)
  })

  // Policy v4: `巡检间隔(分钟)` 0/blank is 停跑, and the Gate is the one place that says so.
  // The assertion is the *reason*, not just the refusal: the triage in
  // docs/policy-v4-triage.md counts these rows under that name.
  it('refuses a stopped row (巡检间隔=0) with schedule-stopped, never as "due every round"', () => {
    const result = policy.gate(facts({ intervalMin: 0 }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('schedule-stopped')
  })

  it('refuses a row whose schedule fact is missing, because an unstated interval is not a licence', () => {
    const { intervalMin: _omitted, ...withoutInterval } = trigger().meta['facts'] as Record<string, unknown>
    const result = policy.gate(trigger({ facts: withoutInterval }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('schedule-stopped')
  })

  it('admits the same row once its interval is positive again (停跑 → 恢复)', () => {
    expect(policy.gate(facts({ intervalMin: 0 }), thread, []).admissible).toBe(false)
    expect(policy.gate(facts({ intervalMin: 1440 }), thread, []).admissible).toBe(true)
  })

  it('reads the schedule before approval and authorization, so a stopped row reports one reason', () => {
    for (const stopped of [
      facts({ intervalMin: 0, approval: '阻塞' }),
      facts({ intervalMin: 0, authorization: '只读' }),
      facts({ intervalMin: 0, nextStepPresent: false }),
    ]) {
      const result = policy.gate(stopped, thread, [])
      expect(result.admissible).toBe(false)
      if (!result.admissible) expect(result.reason).toBe('schedule-stopped')
    }
  })

  it('refuses when the thread already has an open ticket', () => {
    const open = { id: 'tkt1', status: 'open' } as unknown as Ticket
    const result = policy.gate(trigger(), thread, [open])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('ticket-already-open')
  })

  it('admits nothing while paused', () => {
    const paused = new DirectionPolicy({ version: 'v1', paused: true, allowAnyRepo: true })
    const result = paused.gate(trigger(), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('policy-paused')
  })
})

describe('DirectionPolicy.revalidate', () => {
  it('keeps a mandate granted under the same version', () => {
    const policy = new DirectionPolicy({ version: 'v2' })
    const mandate = { scope: 'x', strength: 'explicit' as const, basis: { policyVersion: 'v2', origin: 'row:rec1', strength: 'explicit' as const, at: 'now' } }
    expect(policy.revalidate(mandate)).toBe(true)
  })

  it('does not widen an inferred mandate across a policy change', () => {
    const policy = new DirectionPolicy({ version: 'v2' })
    const mandate = { scope: 'x', strength: 'inferred' as const, basis: { policyVersion: 'v1', origin: 'row:rec1', strength: 'inferred' as const, at: 'now' } }
    expect(policy.revalidate(mandate)).toBe(false)
  })
})

describe('DirectionPolicy repo allowlist', () => {
  const policy = new DirectionPolicy({
    version: 'v3',
    autonomousRepos: ['D:\\gitAll\\dsh-patrol', 'E:/gitAll/openeyes/'],
  })

  it('admits a row inside an allowlisted repo, separators and case ignored', () => {
    expect(policy.gate(facts({ repoPath: 'd:/gitall/dsh-patrol' }), thread, []).admissible).toBe(true)
    expect(policy.gate(facts({ repoPath: 'E:\\gitAll\\openeyes' }), thread, []).admissible).toBe(true)
    expect(policy.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol\\src\\core' }), thread, []).admissible).toBe(true)
  })

  it('refuses a row whose repo is outside every prefix', () => {
    const result = policy.gate(facts({ repoPath: 'E:\\repos\\gitAll\\articleeditor-tmp' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-not-autonomous')
  })

  it('does not read a sibling with the same prefix as inside', () => {
    const result = policy.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol-old' }), thread, [])
    expect(result.admissible).toBe(false)
  })

  it('refuses a row that names no repo at all', () => {
    const result = policy.gate(facts({ repoPath: '   ' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('no-repo-path')
  })

  it('refuses a repo the table itself marks as not cloned', () => {
    const result = policy.gate(facts({ repoPath: '（未克隆）https://github.com/x/y' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-not-cloned')
  })

  it('runs the repo layer before the ticket layer, so an allowlisted repo still reports ticket-already-open', () => {
    const open = { id: 'tkt1', status: 'open' } as unknown as Ticket
    const result = policy.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol' }), thread, [open])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('ticket-already-open')
  })
})

describe('DirectionPolicy repo-exists layer', () => {
  // The opt-in keeps the allowlist layer out of the way, so each assertion is about the file
  // system fact alone — the same isolation the v3 block uses for the allowlist.
  const policy = new DirectionPolicy({ version: 'v4', allowAnyRepo: true })

  it('admits only when the cell proved one reachable directory', () => {
    expect(policy.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol' }), thread, []).admissible).toBe(true)
  })

  it('refuses a row with no repo fact at all, because an unprobed cell is not a licence', () => {
    const result = policy.gate(facts({ repoExists: undefined }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-exists-unknown')
  })

  it('reports the fact\'s own reason instead of collapsing every refusal into one', () => {
    for (const [reason, fact] of [
      ['repo-missing', repoFact({ exists: false, kind: 'missing', normalizedPath: '', reason: 'repo-missing' })],
      ['repo-path-ambiguous', repoFact({ exists: false, kind: 'multiple', normalizedPath: '', reason: 'repo-path-ambiguous' })],
      ['repo-empty-cell', repoFact({ exists: false, kind: 'empty', normalizedPath: '', reason: 'repo-empty-cell' })],
      ['repo-path-unreachable', repoFact({ exists: false, kind: 'unreachable', normalizedPath: '', reason: 'repo-path-unreachable' })],
      ['repo-not-a-directory', repoFact({ exists: true, kind: 'file', reason: 'repo-not-a-directory' })],
      ['repo-path-relative-unresolved', repoFact({ exists: false, kind: 'unresolved', normalizedPath: '', reason: 'repo-path-relative-unresolved' })],
    ] as const) {
      const result = policy.gate(facts({ repoExists: fact }), thread, [])
      expect(result.admissible).toBe(false)
      if (!result.admissible) expect(result.reason).toBe(reason)
    }
  })

  it('refuses a fact that says ok while its own fields say otherwise', () => {
    const result = policy.gate(facts({ repoExists: repoFact({ exists: false, kind: 'missing' }) }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-not-a-directory')
  })

  it('runs the existence check after the allowlist and before the ticket layer', () => {
    const allowlisted = new DirectionPolicy({ version: 'v4', autonomousRepos: ['D:\\gitAll\\dsh-patrol'] })
    const missing = facts({ repoPath: 'D:\\gitAll\\dsh-patrol', repoExists: repoFact({ exists: false, kind: 'missing', reason: 'repo-missing' }) })
    const open = { id: 'tkt1', status: 'open', repoPath: 'D:\\gitAll\\dsh-patrol' } as unknown as Ticket
    const result = allowlisted.gate(missing, thread, [open])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-missing')
  })
})

describe('DirectionPolicy action layer', () => {
  // The repo layer is satisfied by a real directory; each case below changes only the action fact,
  // so the assertion is about the new layer and not about the repo allowlist.
  const policy = new DirectionPolicy({ version: 'v4', allowAnyRepo: true })

  it('admits repo work: code, test and doc all pass', () => {
    for (const kind of ['repo-code', 'repo-test', 'repo-doc'] as const) {
      expect(policy.gate(facts({ actionFacts: actionFact({ kind }) }), thread, []).admissible).toBe(true)
    }
  })

  it('refuses a row whose action needs a key, with its own reason', () => {
    const result = policy.gate(facts({ actionFacts: actionFact({ kind: 'secret', matched: ['密钥'], field: '下一步' }) }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('action-needs-secret')
  })

  it('gives every non-repo kind a distinct reason the decision log can carry', () => {
    for (const [kind, reason] of [
      ['field-ops', 'action-field-ops'],
      ['release', 'action-release'],
      ['secret', 'action-needs-secret'],
      ['config', 'action-needs-config'],
      ['decision', 'action-needs-decision'],
      ['unclear', 'action-unclear'],
    ] as const) {
      const result = policy.gate(facts({ actionFacts: actionFact({ kind, matched: [kind] }) }), thread, [])
      expect(result.admissible).toBe(false)
      if (!result.admissible) expect(result.reason).toBe(reason)
    }
  })

  it('refuses a row with no action fact at all, because an unclassified action is not a licence', () => {
    const result = policy.gate(facts({ actionFacts: undefined }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('action-facts-unknown')
  })

  it('refuses a repo-kind fact that carries no matched word', () => {
    const result = policy.gate(facts({ actionFacts: actionFact({ matched: [] }) }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('action-unclear')
  })

  // A column-written kind has no word list by design; refusing it for empty `matched` would make the
  // structured column decoration. The exemption needs all three marks, not just the label.
  it('admits a repo kind written in the 动作类型 column, which has no matched words', () => {
    const fromColumn = actionFact({ source: 'column', field: '动作类型', matched: [], evidence: 'repo-code' })
    expect(policy.gate(facts({ actionFacts: fromColumn }), thread, []).admissible).toBe(true)
  })

  it('still refuses a fact that claims to come from the column without carrying its value', () => {
    const forged = actionFact({ source: 'column', field: '动作类型', matched: [], evidence: '' })
    const result = policy.gate(facts({ actionFacts: forged }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('action-unclear')
  })

  it('runs after the repo layer and before the ticket layer', () => {
    const allowlisted = new DirectionPolicy({ version: 'v4', autonomousRepos: ['D:\\gitAll\\dsh-patrol'] })
    const open = { id: 'tkt1', status: 'open', repoPath: 'D:\\gitAll\\dsh-patrol' } as unknown as Ticket
    const missingRepo = facts({
      repoPath: 'D:\\gitAll\\dsh-patrol',
      repoExists: repoFact({ exists: false, kind: 'missing', reason: 'repo-missing' }),
      actionFacts: actionFact({ kind: 'secret', matched: ['密钥'] }),
    })
    const missing = allowlisted.gate(missingRepo, thread, [open])
    expect(missing.admissible).toBe(false)
    if (!missing.admissible) expect(missing.reason).toBe('repo-missing')

    const secret = allowlisted.gate(facts({
      repoPath: 'D:\\gitAll\\dsh-patrol',
      actionFacts: actionFact({ kind: 'secret', matched: ['密钥'] }),
    }), thread, [open])
    expect(secret.admissible).toBe(false)
    if (!secret.admissible) expect(secret.reason).toBe('action-needs-secret')
  })
})

describe('DirectionPolicy v3 fail-closed default', () => {
  it('refuses an empty allowlist instead of reading it as "no restriction"', () => {
    const v3 = new DirectionPolicy({ version: 'v3' })
    const result = v3.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-allowlist-unset')
  })

  it('refuses an empty allowlist even when the row names no repo (no array is not a bypass)', () => {
    const v3 = new DirectionPolicy({ version: 'v3', autonomousRepos: [] })
    const result = v3.gate(facts({ repoPath: '' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-allowlist-unset')
  })

  it('treats an all-blank allowlist as unset, not as a wildcard', () => {
    const v3 = new DirectionPolicy({ version: 'v3', autonomousRepos: ['   ', ''] })
    const result = v3.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol' }), thread, [])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-allowlist-unset')
  })

  it('admits any repo only behind an explicit opt-in, never behind an empty array', () => {
    const optedIn = new DirectionPolicy({ version: 'v3', allowAnyRepo: true })
    expect(optedIn.gate(facts({ repoPath: '' }), thread, []).admissible).toBe(true)
    expect(optedIn.gate(facts({ repoPath: 'E:\\repos\\anything' }), thread, []).admissible).toBe(true)
  })

  it('keeps the repo layer ahead of the ticket layer: empty allowlist refuses first', () => {
    const v3 = new DirectionPolicy({ version: 'v3' })
    const open = { id: 'tkt1', status: 'open' } as unknown as Ticket
    const result = v3.gate(facts({ repoPath: 'D:\\gitAll\\dsh-patrol' }), thread, [open])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('repo-allowlist-unset')
  })
})
