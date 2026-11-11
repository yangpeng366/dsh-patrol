import { describe, expect, it } from 'vitest'
import { itemActionFact, itemFacts, itemFingerprint, itemIsDue, itemIsStopped, itemRepoFact, itemThreadKey, itemToTrigger } from '../src/mapping.ts'
import { normalizeItem, type DirectionItem } from '../src/source/provider.ts'

const base: DirectionItem = normalizeItem({
  id: 'rec1', title: '示例', nextStep: '做事', priority: 'P1', intervalMin: 60,
  authorization: '自主', collaboration: 'sparse', approval: '已通过', currentStage: '开发',
  lastRun: '2026-11-10T00:00:00.000Z',
})

describe('mapping', () => {
  it('gives the same fingerprint to an unchanged row', () => {
    expect(itemFingerprint(base)).toBe(itemFingerprint({ ...base }))
  })

  it('changes the fingerprint when the next step changes', () => {
    expect(itemFingerprint(base)).not.toBe(itemFingerprint({ ...base, nextStep: '换一件事' }))
  })

  // Without this, a row that is resumed from 停跑 keeps the Trigger id it was refused under, and
  // `receive()` treats the resume as a duplicate: the Gate would never see the new interval.
  it('changes the fingerprint when a stopped row is resumed (停跑 → 恢复生新 Trigger)', () => {
    const stopped = { ...base, intervalMin: 0 }
    expect(itemFingerprint(stopped)).not.toBe(itemFingerprint({ ...base, intervalMin: 60 }))
    expect(itemToTrigger(stopped, '2026-11-10T01:00:00.000Z').id)
      .not.toBe(itemToTrigger({ ...base, intervalMin: 1440 }, '2026-11-10T01:00:00.000Z').id)
  })

  it('keys a thread by the row id', () => {
    expect(itemThreadKey(base)).toBe('patrol:rec1')
  })

  // The column is state, like the repo probe: writing or correcting it must produce a new Trigger
  // (otherwise the row keeps the verdict it was refused under). Missing and blank hash the same, so
  // a table without the column still produces the pre-column ids.
  it('changes the fingerprint when the structured action kind is written or corrected', () => {
    expect(itemFingerprint(base)).toBe(itemFingerprint({ ...base, actionType: undefined }))
    expect(itemFingerprint(base)).not.toBe(itemFingerprint({ ...base, actionType: 'repo-code' }))
    expect(itemFingerprint({ ...base, actionType: 'repo-code' })).not.toBe(itemFingerprint({ ...base, actionType: 'release' }))
  })

  // Policy v4: the repo cell is a fact, and it is probed — not inferred from the path's shape.
  it('carries the probed repo cell into the facts', () => {
    const probed = itemToTrigger({ ...base, repoPath: 'D:\\gitAll\\dsh-patrol' }, '2026-11-10T01:00:00.000Z', {
      probe: () => ({ kind: 'directory' }),
    })
    expect(probed.meta['facts']).toMatchObject({
      repoPath: 'D:\\gitAll\\dsh-patrol',
      repoExists: { exists: true, kind: 'directory', normalizedPath: 'D:\\gitAll\\dsh-patrol', reason: 'repo-exists-ok' },
    })
  })

  it('reports an empty repo cell as a refusal rather than as "no repo needed"', () => {
    expect(itemRepoFact(base)).toMatchObject({ exists: false, kind: 'empty', reason: 'repo-empty-cell' })
    expect(itemFacts(base, itemRepoFact(base))).toMatchObject({ repoExists: { reason: 'repo-empty-cell' } })
  })

  // Policy v4, second fact: the repo cell says where, the action fact says whether the work is
  // inside it. Both come from the row and neither is a Gate-time guess.
  it('carries the action type as a fact, read from the row\'s own cells', () => {
    const row = { ...base, nextStep: '现场升级镜像后复验登录页', repoPath: 'D:\\gitAll\\dsh-patrol' }
    expect(itemFacts(row).actionFacts).toMatchObject({ kind: 'field-ops', field: '下一步' })
    expect(itemToTrigger(row, '2026-11-10T01:00:00.000Z', { probe: () => ({ kind: 'directory' }) }).meta['actionFacts'])
      .toMatchObject({ kind: 'field-ops' })
  })

  it('defaults an unreadable next step to unclear, never to repo-code', () => {
    const row = { ...base, nextStep: 'Review the saved Codex output' }
    expect(itemFacts(row).actionFacts).toMatchObject({ kind: 'unclear' })
  })

  // The structured column, when the table has one, is the fact: even a 发版 sentence does not
  // re-classify the row, and the fact says where it came from.
  it('takes the 动作类型 column over the word list and marks the source', () => {
    const row = { ...base, nextStep: '构建并发版到 60', actionType: 'repo-code' }
    expect(itemActionFact(row)).toMatchObject({ kind: 'repo-code', source: 'column', field: '动作类型' })
    expect(itemFacts(row).actionFacts).toMatchObject({ source: 'column' })
  })

  it('stays a text fact when the row has no column, which is the pre-column behaviour', () => {
    const row = { ...base, nextStep: '补一个单测' }
    expect(row.actionType).toBeUndefined()
    expect(itemActionFact(row)).toMatchObject({ kind: 'repo-test', source: 'text' })
  })

  it('refuses an unreadable column value with the column named as evidence', () => {
    const row = { ...base, nextStep: '编译并提交代码', actionType: 'auto' }
    expect(itemActionFact(row)).toMatchObject({ kind: 'unclear', source: 'column', field: '动作类型', evidence: 'auto' })
  })

  it('passes the probe through, so a cell is read against the filesystem the caller names', () => {
    const seen: string[] = []
    const fact = itemRepoFact({ ...base, repoPath: 'relative\\repo' }, {
      baseDir: 'D:\\gitAll',
      probe: (path) => { seen.push(path); return { kind: 'missing' } },
    })
    expect(seen).toEqual(['D:\\gitAll\\relative\\repo'])
    expect(fact.reason).toBe('repo-missing')
  })

  // A clone appearing is a state change: without it in the fingerprint, `receive()` would treat the
  // re-judgement as a duplicate and the row would stay refused as `repo-missing` forever.
  it('changes the fingerprint when the repo goes from missing to present', () => {
    expect(itemFingerprint(base, 'missing')).not.toBe(itemFingerprint(base, 'exists'))
  })

  it('makes a content-addressed trigger id', () => {
    const trigger = itemToTrigger(base, '2026-11-10T01:00:00.000Z')
    expect(trigger.id).toBe(itemToTrigger(base, '2026-11-10T09:00:00.000Z').id)
    expect(trigger.id).not.toBe(itemToTrigger({ ...base, nextStep: '别的' }, '2026-11-10T01:00:00.000Z').id)
    expect(trigger.meta['facts']).toMatchObject({ authorization: '自主', nextStepPresent: true, intervalMin: 60 })
  })

  it('carries 巡检间隔(分钟) as a structured fact, including the stopped value', () => {
    expect((itemToTrigger(base, '2026-11-10T01:00:00.000Z').meta['facts'] as Record<string, unknown>)['intervalMin']).toBe(60)
    const stopped = normalizeItem({ id: 'rec3', nextStep: '做事', intervalMin: 0, authorization: '自主' })
    expect((itemToTrigger(stopped, '2026-11-10T01:00:00.000Z').meta['facts'] as Record<string, unknown>)['intervalMin']).toBe(0)
  })

  it('applies the row interval', () => {
    const now = new Date('2026-11-10T02:00:00.000Z')
    // lastRun 00:00 with a 60 minute interval: two hours have passed, so the row is due.
    expect(itemIsDue(base, now)).toBe(true)
    // lastRun 30 minutes ago with a 60 minute interval: not due yet.
    expect(itemIsDue({ ...base, lastRun: '2026-11-10T01:30:00.000Z' }, now)).toBe(false)
    // A row that never ran is due.
    expect(itemIsDue({ ...base, lastRun: null }, now)).toBe(true)
    // A long interval keeps a recent row asleep.
    expect(itemIsDue({ ...base, intervalMin: 1440, lastRun: '2026-11-10T01:30:00.000Z' }, now)).toBe(false)
  })

  it('never treats 停跑(0) as due, so a stopped row is not refused once an hour', () => {
    const now = new Date('2026-11-10T02:00:00.000Z')
    // The old reading turned 0 into "every 60 minutes": the row reached the Gate hourly only to be
    // refused as `schedule-stopped`. Not due is the whole point — the round records it as `stopped`
    // instead (`tests/runner.spec.ts` asserts the record is not lost).
    expect(itemIsDue({ ...base, intervalMin: 0, lastRun: '2026-11-10T01:00:00.000Z' }, now)).toBe(false)
    // Even a row that never ran stays out of the due set while its schedule is stopped.
    expect(itemIsDue({ ...base, intervalMin: 0, lastRun: null }, now)).toBe(false)
    expect(itemIsStopped({ ...base, intervalMin: 0 })).toBe(true)
    expect(itemIsStopped(base)).toBe(false)
  })
})

describe('normalizeItem', () => {
  it('defaults unknown fields instead of failing', () => {
    const item = normalizeItem({ id: 'rec2' })
    expect(item.priority).toBe('P2')
    expect(item.authorization).toBe('自主')
    expect(item.collaboration).toBe('sparse')
    expect(item.approval).toBe('已通过')
    expect(item.intervalMin).toBe(0)
    expect(item.threadId).toBeNull()
    // No `动作类型` column: "no structured answer", not an empty string a typo could be confused with.
    expect(item.actionType).toBeUndefined()
  })

  it('keeps a trimmed 动作类型 value and drops a blank one', () => {
    expect(normalizeItem({ id: 'rec4', actionType: '  Repo-Test ' }).actionType).toBe('Repo-Test')
    expect(normalizeItem({ id: 'rec5', actionType: '   ' }).actionType).toBeUndefined()
  })
})