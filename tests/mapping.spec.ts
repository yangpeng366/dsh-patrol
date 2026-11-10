import { describe, expect, it } from 'vitest'
import { itemFacts, itemFingerprint, itemIsDue, itemRepoFact, itemThreadKey, itemToTrigger } from '../src/mapping.ts'
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
    // 停跑(0) still passes the due filter on purpose: admission is the Gate's `schedule-stopped`,
    // so the refusal is recorded in the decision log instead of the row vanishing from it.
    expect(itemIsDue({ ...base, intervalMin: 0, lastRun: '2026-11-10T01:00:00.000Z' }, now)).toBe(true)
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
  })
})