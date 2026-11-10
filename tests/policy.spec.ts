import { describe, expect, it } from 'vitest'
import { DirectionPolicy } from '../src/core/policy.ts'
import type { Thread, Ticket, Trigger } from '../src/core/model.ts'

const thread: Thread = { key: 'patrol:rec1', source: 'direction-table', triggerIds: ['trg1'] }

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
  const policy = new DirectionPolicy({ version: 'v1' })

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

  it('refuses when the thread already has an open ticket', () => {
    const open = { id: 'tkt1', status: 'open' } as unknown as Ticket
    const result = policy.gate(trigger(), thread, [open])
    expect(result.admissible).toBe(false)
    if (!result.admissible) expect(result.reason).toBe('ticket-already-open')
  })

  it('admits nothing while paused', () => {
    const paused = new DirectionPolicy({ version: 'v1', paused: true })
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