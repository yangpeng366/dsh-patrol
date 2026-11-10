import { describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import type { Assignment, Ticket, Trigger } from '../src/core/model.ts'

function trigger(id: string, overrides: Record<string, unknown> = {}): Trigger {
  return {
    id,
    source: 'direction-table',
    threadKey: 'patrol:rec1',
    at: '2026-11-10T00:00:00.000Z',
    strength: 'explicit',
    meta: {
      origin: 'row:rec1',
      itemId: 'rec1',
      title: '示例方向',
      nextStep: '把下一步做完',
      repoPath: 'D:\\gitAll\\demo',
      stage: '开发',
      facts: { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true },
      ...overrides,
    },
  }
}

function engine(options: { mode?: 'off' | 'observe' | 'auto'; collaborate?: string } = {}) {
  const started: { ticket: Ticket; assignment: Assignment }[] = []
  const decisions: string[] = []
  const policy = new DirectionPolicy({ version: 'v1', allowAnyRepo: true })
  const instance = new Engine({
    policy,
    assessor: {
      assess: async () => ({ kind: 'accept', title: '示例方向', scope: 'D:\\gitAll\\demo', reason: 'ok', rules: ['next-step-present'] }),
    },
    acceptMode: options.mode ?? 'auto',
    now: () => new Date('2026-11-10T01:00:00.000Z'),
    sink: { start: (ticket, assignment) => { started.push({ ticket, assignment }) } },
    onDecision: (decision) => decisions.push(decision.verdict),
  })
  return { instance, started, decisions }
}

describe('Engine rounds', () => {
  it('opens one ticket and starts one assignment for an admitted trigger', async () => {
    const { instance, started, decisions } = engine()
    expect(instance.receive(trigger('trg1'))).toBe(true)
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.admitted).toBe(1)
    expect(summary.tickets).toHaveLength(1)
    expect(started).toHaveLength(1)
    expect(started[0]!.ticket.status).toBe('running')
    expect(started[0]!.ticket.mandate.basis.policyVersion).toBe('v1')
    expect(decisions).toEqual(['admitted'])
  })

  it('ignores a trigger it has already judged', async () => {
    const { instance, started } = engine()
    instance.receive(trigger('trg1'))
    await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(instance.receive(trigger('trg1'))).toBe(false)
    const second = await instance.runRound(new Date('2026-11-10T02:00:00.000Z'))
    expect(second.evaluated).toBe(0)
    expect(started).toHaveLength(1)
  })

  it('holds an inferred verdict in observe mode and starts nothing', async () => {
    const { instance, started, decisions } = engine({ mode: 'observe' })
    instance.receive(trigger('trg1', { facts: { authorization: '自主', collaboration: 'approve', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true } }))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.observed).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(started).toHaveLength(0)
    expect(decisions).toEqual(['observed'])
  })

  it('holds an explicit verdict too in observe mode', async () => {
    const { instance, started, decisions } = engine({ mode: 'observe' })
    instance.receive(trigger('trg1'))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.observed).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(started).toHaveLength(0)
    expect(decisions).toEqual(['observed'])
  })

  it('starts explicit work in auto mode', async () => {
    const { instance, started } = engine({ mode: 'auto' })
    instance.receive(trigger('trg1'))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.admitted).toBe(1)
    expect(started).toHaveLength(1)
  })

  it('starts nothing at all in off mode', async () => {
    const { instance, started } = engine({ mode: 'off' })
    instance.receive(trigger('trg1'))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.admitted).toBe(0)
    expect(started).toHaveLength(0)
  })

  it('judges every pending trigger, not only the first of a thread', async () => {
    const { instance, started } = engine({ mode: 'auto' })
    instance.receive(trigger('trg1'))
    instance.receive(trigger('trg2'))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.evaluated).toBe(2)
    // The second trigger of the same thread finds the ticket the first one opened.
    expect(summary.admitted).toBe(1)
    expect(started).toHaveLength(1)
  })

  it('refuses a second trigger while the thread still has an open ticket', async () => {
    const { instance, started } = engine()
    instance.receive(trigger('trg1'))
    await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    instance.receive(trigger('trg2'))
    const summary = await instance.runRound(new Date('2026-11-10T02:00:00.000Z'))
    expect(summary.ignored).toBe(1)
    expect(started).toHaveLength(1)
  })

  it('records an unavailable assessment without opening a ticket', async () => {
    const policy = new DirectionPolicy({ version: 'v1', allowAnyRepo: true })
    const instance = new Engine({
      policy,
      assessor: { assess: async () => ({ kind: 'unavailable', reason: 'model-timeout' }) },
      now: () => new Date('2026-11-10T01:00:00.000Z'),
    })
    instance.receive(trigger('trg1'))
    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.unavailable).toBe(1)
    expect(instance.tickets()).toHaveLength(0)
  })

  it('ends a ticket on request', async () => {
    const { instance } = engine()
    instance.receive(trigger('trg1'))
    await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    const ticket = instance.tickets()[0]!
    instance.endTicket(ticket.id, 'person', 'dropped')
    expect(instance.ticket(ticket.id)!.status).toBe('ended')
    expect(instance.ticket(ticket.id)!.outcome).toBe('dropped')
  })
})