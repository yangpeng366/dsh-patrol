import { describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import type { Assignment, Ticket, Trigger } from '../src/core/model.ts'

/** Repo work, as `itemActionFact()` reads it; a row without one is refused as `action-facts-unknown`. */
const repoWork = { kind: 'repo-code', source: 'text', matched: ['实现'], evidence: '把下一步做完', field: '下一步', reason: '仓内动作', alternatives: [] }

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
      facts: { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 60, repoPath: 'D:\\gitAll\\demo', repoExists: { raw: 'D:\\gitAll\\demo', exists: true, kind: 'directory', normalizedPath: 'D:\\gitAll\\demo', reason: 'repo-exists-ok', candidates: [] }, actionFacts: repoWork },
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
    instance.receive(trigger('trg1', { facts: { authorization: '自主', collaboration: 'approve', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 60, repoPath: 'D:\\gitAll\\demo', repoExists: { raw: 'D:\\gitAll\\demo', exists: true, kind: 'directory', normalizedPath: 'D:\\gitAll\\demo', reason: 'repo-exists-ok', candidates: [] }, actionFacts: repoWork } }))
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

  it('keeps the ended record when the same row opens again', async () => {
    const { instance, started } = engine()
    instance.receive(trigger('trg1'))
    const first = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'))
    const firstId = first.tickets[0]!
    instance.endTicket(firstId, 'person', 'dropped')

    // Same row, next generation: a new Trigger keeps the thread key, and the Ticket id must
    // move to `-r2` instead of overwriting the ended record in the store.
    instance.receive(trigger('trg2'))
    const second = await instance.runRound(new Date('2026-11-10T02:00:00.000Z'))
    const secondId = second.tickets[0]!
    expect(secondId).toBe(`${firstId}-r2`)
    expect(instance.tickets()).toHaveLength(2)
    expect(instance.ticket(firstId)!.status).toBe('ended')
    expect(instance.ticket(firstId)!.outcome).toBe('dropped')
    expect(instance.ticket(secondId)!.status).toBe('running')
    expect(started).toHaveLength(2)
  })

  it('records stopped rows without judging them, and keeps `evaluated` at zero', async () => {
    let assessments = 0
    const records: { verdict: string; reason: string; recordId?: string; intervalMin?: number }[] = []
    const instance = new Engine({
      policy: new DirectionPolicy({ version: 'v4', allowAnyRepo: true }),
      assessor: {
        assess: async () => {
          assessments += 1
          return { kind: 'accept', title: '示例方向', scope: 'D:\\gitAll\\demo', reason: 'ok', rules: ['next-step-present'] }
        },
      },
      acceptMode: 'observe',
      now: () => new Date('2026-11-10T01:00:00.000Z'),
      onDecision: (decision) => records.push(decision),
    })
    const stoppedRow = trigger('trg-stop', { facts: { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 0, repoPath: 'D:\\gitAll\\demo' } })

    const summary = await instance.runRound(new Date('2026-11-10T01:00:00.000Z'), { stopped: [stoppedRow] })

    expect(assessments).toBe(0)
    expect(summary.stopped).toBe(1)
    expect(summary.evaluated).toBe(0)
    expect(summary.ignored).toBe(0)
    expect(summary.tickets).toEqual([])
    expect(records).toEqual([
      expect.objectContaining({ verdict: 'stopped', reason: 'schedule-stopped', recordId: 'rec1', intervalMin: 0 }),
    ])
    // Recorded, not pending: a later round does not pick it up by itself either.
    expect(instance.pending()).toEqual([])
  })
})
