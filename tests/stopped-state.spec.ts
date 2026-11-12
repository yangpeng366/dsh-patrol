import { describe, expect, it } from 'vitest'
import { Engine, type DecisionRecord } from '../src/core/engine.ts'
import type { Trigger } from '../src/core/model.ts'
import { DirectionPolicy } from '../src/core/policy.ts'

function stoppedTrigger(recordId: string, intervalMin = 0): Trigger {
  return {
    id: `trg_${recordId}_${intervalMin}`,
    source: 'direction-table',
    threadKey: `patrol:${recordId}`,
    at: '2026-11-10T00:00:00.000Z',
    strength: 'explicit',
    meta: {
      itemId: recordId,
      title: recordId,
      facts: { intervalMin },
    },
  }
}

function stoppedEngine(stoppedHeartbeatMs = 12 * 60 * 60 * 1000): { engine: Engine; records: DecisionRecord[] } {
  const records: DecisionRecord[] = []
  const engine = new Engine({
    policy: new DirectionPolicy({ version: 'v4', allowAnyRepo: true }),
    assessor: {
      assess: async () => {
        throw new Error('a stopped row must never reach the Assessor')
      },
    },
    stoppedHeartbeatMs,
    onDecision: (record) => { records.push(record) },
  })
  return { engine, records }
}

const T0 = new Date('2026-11-10T01:00:00.000Z')

describe('stopped-set decision log', () => {
  it('writes the full set on the first round, sorted by row id', async () => {
    const { engine, records } = stoppedEngine()
    const summary = await engine.runRound(T0, { stopped: [stoppedTrigger('rec-b'), stoppedTrigger('rec-a')] })

    expect(summary.stopped).toBe(2)
    expect(summary.evaluated).toBe(0)
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.recordId)).toEqual(['rec-a', 'rec-b'])
    expect(records.every((record) => record.verdict === 'stopped' && record.reason === 'schedule-stopped')).toBe(true)
    expect(records.every((record) => record.stoppedEvent === 'snapshot')).toBe(true)
    expect(records.every((record) => record.stoppedCount === 2)).toBe(true)
    expect(records[0]!.stoppedFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(records[0]!.stoppedFingerprint).toBe(records[1]!.stoppedFingerprint)
  })

  it('stays silent on the next round when the set did not change', async () => {
    const { engine, records } = stoppedEngine()
    const stopped = [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')]
    await engine.runRound(T0, { stopped })
    const summary = await engine.runRound(new Date(T0.getTime() + 60 * 60 * 1000), { stopped })

    expect(summary.stopped).toBe(2)
    expect(records).toHaveLength(2)
  })

  it('writes one `added` line when a row enters the stopped set', async () => {
    const { engine, records } = stoppedEngine()
    await engine.runRound(T0, { stopped: [stoppedTrigger('rec-a')] })
    await engine.runRound(new Date(T0.getTime() + 60 * 60 * 1000), {
      stopped: [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')],
    })

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      recordId: 'rec-b',
      verdict: 'stopped',
      reason: 'schedule-stopped',
      stoppedEvent: 'added',
      stoppedCount: 2,
    })
  })

  it('writes one `removed` line when a row resumes running', async () => {
    const { engine, records } = stoppedEngine()
    await engine.runRound(T0, { stopped: [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')] })
    const summary = await engine.runRound(new Date(T0.getTime() + 60 * 60 * 1000), {
      stopped: [stoppedTrigger('rec-a')],
    })

    expect(summary.stopped).toBe(1)
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({
      recordId: 'rec-b',
      verdict: 'stopped',
      reason: 'schedule-stopped',
      stoppedEvent: 'removed',
      stoppedCount: 1,
    })
    expect(records[2]!.stoppedFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(records[2]!.stoppedFingerprint).not.toBe(records[0]!.stoppedFingerprint)
  })

  it('writes one heartbeat when the unchanged set reaches the injected period', async () => {
    const { engine, records } = stoppedEngine(60 * 60 * 1000)
    const stopped = [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')]
    await engine.runRound(T0, { stopped })
    await engine.runRound(new Date(T0.getTime() + 30 * 60 * 1000), { stopped })
    expect(records).toHaveLength(2)

    await engine.runRound(new Date(T0.getTime() + 61 * 60 * 1000), { stopped })
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({
      verdict: 'stopped',
      reason: 'schedule-stopped',
      stoppedEvent: 'heartbeat',
      stoppedCount: 2,
    })
    expect(records[2]!.stoppedFingerprint).toBe(records[0]!.stoppedFingerprint)
  })

  it('keeps the first-seen time while a row stays stopped', async () => {
    const { engine, records } = stoppedEngine(60 * 60 * 1000)
    const later = new Date(T0.getTime() + 61 * 60 * 1000)
    await engine.runRound(T0, { stopped: [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')] })
    await engine.runRound(later, { stopped: [stoppedTrigger('rec-a'), stoppedTrigger('rec-b')] })

    expect(records).toHaveLength(3)
    expect(records[2]!.stoppedEvent).toBe('heartbeat')
    // The heartbeat names the set, not a row; the rows themselves still start at T0.
    expect(records[0]!.stoppedSince).toBe(T0.toISOString())
    expect(records[1]!.stoppedSince).toBe(T0.toISOString())
  })

  it('writes removed then added when a row stops, resumes and stops again', async () => {
    const { engine, records } = stoppedEngine()
    const resumedAt = new Date(T0.getTime() + 60 * 60 * 1000)
    const stoppedAgainAt = new Date(T0.getTime() + 120 * 60 * 1000)
    await engine.runRound(T0, { stopped: [stoppedTrigger('rec-a')] })
    // A resumes: it leaves the set and is judged normally by the next round.
    await engine.runRound(resumedAt, { stopped: [] })
    await engine.runRound(stoppedAgainAt, { stopped: [stoppedTrigger('rec-a')] })

    expect(records.map((record) => record.stoppedEvent)).toEqual(['snapshot', 'removed', 'added'])
    expect(records[1]!.recordId).toBe('rec-a')
    expect(records[1]!.stoppedCount).toBe(0)
    // The second stop is a new interval, so its first-seen time is not the original one.
    expect(records[2]!.stoppedSince).toBe(stoppedAgainAt.toISOString())
    expect(records[2]!.stoppedSince).not.toBe(records[0]!.stoppedSince)
  })
})
