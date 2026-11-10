import { describe, expect, it } from 'vitest'
import { itemFingerprint, itemIsDue, itemThreadKey, itemToTrigger } from '../src/mapping.ts'
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