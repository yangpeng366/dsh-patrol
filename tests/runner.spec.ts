import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import { LogDispatcher } from '../src/dispatch.ts'
import { PatrolRunner } from '../src/runner.ts'
import { LocalJsonSource } from '../src/source/local-json.ts'

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-test-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify([
    {
      id: 'rec-due', title: '到期方向', nextStep: '做掉它', priority: 'P0', intervalMin: 0,
      authorization: '自主', collaboration: 'sparse', approval: '已通过', currentStage: '开发',
      lastRun: null, repoPath: 'D:\\gitAll\\demo',
    },
    {
      id: 'rec-fresh', title: '刚跑过', nextStep: '再看看', priority: 'P2', intervalMin: 1440,
      authorization: '自主', collaboration: 'sparse', approval: '已通过', currentStage: '维护',
      lastRun: '2026-11-10T00:30:00.000Z', repoPath: 'D:\\gitAll\\demo2',
    },
  ]), 'utf8')
  return file
}

describe('PatrolRunner', () => {
  it('dispatches only the due row and survives a failing write-back', async () => {
    const file = await fixture()
    const source = new LocalJsonSource({ path: file })
    const dispatcher = new LogDispatcher()
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v1' }),
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
    const file = await fixture()
    const source = new LocalJsonSource({ path: file })
    const dispatcher = new LogDispatcher()
    const engine = new Engine({
      policy: new DirectionPolicy({ version: 'v1' }),
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
})