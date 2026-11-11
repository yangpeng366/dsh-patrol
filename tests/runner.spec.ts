import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import { DecisionLog } from '../src/core/decision-log.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import { LogDispatcher } from '../src/dispatch.ts'
import { PatrolRunner } from '../src/runner.ts'
import { LocalJsonFileSource, LocalJsonSource } from '../src/source/local-json.ts'

async function fixture(): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-test-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify([
    {
    // 巡检间隔: an interval is now a fact the Gate reads (Policy v4), so the "due" row carries a
    // real one; `lastRun: null` is what makes it due on the first round.
      id: 'rec-due', title: '到期方向', nextStep: '实现到期方向的下一步', priority: 'P0', intervalMin: 60,
      authorization: '自主', collaboration: 'sparse', approval: '已通过', currentStage: '开发',
      // Policy v4 also reads the repo cell: a row pointing at a directory that is not there is
      // refused as `repo-missing`, so the fixture points at the temp directory it just created.
      lastRun: null, repoPath: dir,
    },
    {
      id: 'rec-fresh', title: '刚跑过', nextStep: '再看看', priority: 'P2', intervalMin: 1440,
      authorization: '自主', collaboration: 'sparse', approval: '已通过', currentStage: '维护',
      lastRun: '2026-11-10T00:30:00.000Z', repoPath: join(dir, 'sibling'),
    },
  ]), 'utf8')
  return { file, dir }
}

describe('PatrolRunner', () => {
  it('dispatches only the due row and survives a failing write-back', async () => {
    const { file } = await fixture()
    const source = new LocalJsonSource({ path: file })
    const dispatcher = new LogDispatcher()
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v1', allowAnyRepo: true }),
      assessor: { assess: async () => ({ kind: 'accept', title: '到期方向', scope: 'D:\\gitAll\\demo', reason: 'ok', rules: ['next-step-present'] }) },
      acceptMode: 'auto',
      now: () => new Date('2026-11-10T02:00:00.000Z'),
    })
    const writeBackErrors: string[] = []
    const runner = new PatrolRunner({
      source,
      engine,
      dispatcher,
      now: () => new Date('2026-11-10T02:00:00.000Z'),
      onWriteBackError: (itemId) => writeBackErrors.push(itemId),
    })

    const summary = await runner.runOnce()
    expect(summary.admitted).toBe(1)
    expect(dispatcher.seen).toHaveLength(1)
    expect(dispatcher.seen[0]!.sourceItemId).toBe('rec-due')
    // LocalJsonSource has no durable backend, so the write-back fails without losing the work.
    expect(writeBackErrors).toEqual(['rec-due'])
  })

  it('does nothing on a second round when the row did not change', async () => {
    const { file } = await fixture()
    const source = new LocalJsonSource({ path: file })
    const dispatcher = new LogDispatcher()
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v1', allowAnyRepo: true }),
      assessor: { assess: async () => ({ kind: 'accept', title: '到期方向', scope: 'D:\\gitAll\\demo', reason: 'ok', rules: ['next-step-present'] }) },
      acceptMode: 'auto',
      now: () => new Date('2026-11-10T02:00:00.000Z'),
    })
    const runner = new PatrolRunner({ source, engine, dispatcher, now: () => new Date('2026-11-10T02:00:00.000Z') })
    await runner.runOnce()
    const second = await runner.runOnce()
    expect(second.admitted).toBe(0)
    expect(dispatcher.seen).toHaveLength(1)
  })

  it('writes the stage and the achievement back without touching the row\'s own next step', async () => {
    const { file } = await fixture()
    const source = new LocalJsonFileSource({ path: file })
    const writeBackErrors: string[] = []
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v1', allowAnyRepo: true }),
      assessor: { assess: async () => ({ kind: 'accept', title: '到期方向', scope: 'D:\\gitAll\\demo', reason: 'ok', rules: ['next-step-present'] }) },
      acceptMode: 'auto',
      now: () => new Date('2026-11-10T02:00:00.000Z'),
    })
    const runner = new PatrolRunner({
      source,
      engine,
      dispatcher: new LogDispatcher(),
      now: () => new Date('2026-11-10T02:00:00.000Z'),
      onWriteBackError: (itemId) => writeBackErrors.push(itemId),
    })
    await runner.runOnce()
    const rows = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[]
    const row = rows.find((entry) => entry['id'] === 'rec-due')!
    expect(writeBackErrors).toEqual([])
    // The scope is not the row's next action: it must survive a round untouched.
    expect(row['nextStep']).toBe('实现到期方向的下一步')
    expect(String(row['achievement'])).toMatch(/^logged tkt_/)
  })

  it('records every stopped row as `stopped` and assesses none of them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-stopped-'))
    const file = join(dir, 'tasks.json')
    // A table of nothing but stopped rows: two write `0`, one leaves 巡检间隔 blank (the table's own
    // convention says both mean 停跑). This is the 口径 self-check: with the due filter no longer
    // reading 0 as 60 minutes, each row must still land in the decision log — as `stopped`, once,
    // with its record id and the interval the table wrote — and the Assessor must never be called.
    await writeFile(file, JSON.stringify([
      { id: 'rec-stop-1', title: '停跑一', nextStep: '补一个单测', priority: 'P1', intervalMin: 0, authorization: '自主', approval: '已通过', currentStage: '开发', lastRun: null, repoPath: dir },
      { id: 'rec-stop-2', title: '停跑二', nextStep: '整理文档', priority: 'P2', intervalMin: 0, authorization: '自主', approval: '已通过', currentStage: '维护', lastRun: '2026-11-10T01:00:00.000Z', repoPath: dir },
      { id: 'rec-stop-3', title: '停跑三（巡检间隔为空）', nextStep: '再看看', priority: 'P2', authorization: '自主', approval: '已通过', currentStage: '验证', lastRun: null, repoPath: dir },
    ]), 'utf8')

    let assessments = 0
    const log = new DecisionLog({ path: join(dir, 'decisions.jsonl'), now: () => new Date('2026-11-10T02:00:00.000Z') })
    const dispatcher = new LogDispatcher()
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v4', allowAnyRepo: true }),
      assessor: {
        assess: async () => {
          assessments += 1
          return { kind: 'accept', title: 'x', scope: dir, reason: 'ok', rules: ['next-step-present'] }
        },
      },
      acceptMode: 'auto',
      now: () => new Date('2026-11-10T02:00:00.000Z'),
      onDecision: (decision) => { log.append(decision) },
    })
    const runner = new PatrolRunner({
      source: new LocalJsonSource({ path: file }),
      engine,
      dispatcher,
      now: () => new Date('2026-11-10T02:00:00.000Z'),
    })

    const summary = await runner.runOnce()

    // No Gate verdict, no Assessment, no dispatch, no money.
    expect(assessments).toBe(0)
    expect(summary.evaluated).toBe(0)
    expect(summary.stopped).toBe(3)
    expect(summary.tickets).toEqual([])
    expect(dispatcher.seen).toEqual([])

    const records = (await readFile(log.path, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    // Visibility first: every stopped row has its own record, none was filtered out of the log.
    expect(records).toHaveLength(3)
    expect(records.map((record) => record['recordId'])).toEqual(['rec-stop-1', 'rec-stop-2', 'rec-stop-3'])
    for (const record of records) {
      expect(record['verdict']).toBe('stopped')
      expect(record['reason']).toBe('schedule-stopped')
      expect(record['intervalMin']).toBe(0)
      expect(record['roundId']).toBe(summary.roundId)
      expect(record['threadKey']).toBe(`patrol:${String(record['recordId'])}`)
      expect(record).not.toHaveProperty('wouldAccept')
      expect(record['ticketId']).toBeUndefined()
    }

    // A second round says it again: the log is the record of "this row is stopped", not an event.
    await runner.runOnce()
    const again = (await readFile(log.path, 'utf8')).split('\n').filter((line) => line !== '')
    expect(again).toHaveLength(6)
    expect(assessments).toBe(0)
  })
})