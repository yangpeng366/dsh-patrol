import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, createDecisionLog, createEngine } from '../src/index.ts'
import { DecisionLog, resolveDecisionLogPath } from '../src/core/decision-log.ts'
import type { DecisionRecord } from '../src/core/engine.ts'
import type { Trigger } from '../src/core/model.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-patrol-log-'))
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    roundId: 'rnd_20261110T010000Z_1',
    evalId: 'eval_aaaaaaaaaaaa',
    threadKey: 'patrol:rec1',
    triggerId: 'trg1',
    verdict: 'observed',
    reason: 'held-by-mode:observe',
    wouldAccept: { title: '示例方向', scope: 'D:\\gitAll\\demo', rules: ['next-step-present'] },
    ...overrides,
  }
}

function trigger(id: string): Trigger {
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
      facts: { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 60 },
    },
  }
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
}

describe('DecisionLog', () => {
  it('appends one JSON line per decision, UTF-8 without BOM', () => {
    const dir = tempDir()
    const path = join(dir, 'decisions.jsonl')
    const log = new DecisionLog({ path, now: () => new Date('2026-11-10T01:00:00.000Z') })

    const first = log.append(decision())
    const second = log.append(decision({ triggerId: 'trg2', verdict: 'ignored', reason: 'no-next-step', wouldAccept: undefined }))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const bytes = readFileSync(path)
    // EF BB BF would be a BOM: Excel and `jq` both choke on one in JSONL.
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])

    const records = lines(path).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      ts: '2026-11-10T01:00:00.000Z',
      roundId: 'rnd_20261110T010000Z_1',
      verdict: 'observed',
      reason: 'held-by-mode:observe',
      threadKey: 'patrol:rec1',
      wouldAccept: { title: '示例方向', scope: 'D:\\gitAll\\demo', rules: ['next-step-present'] },
    })
    expect(records[1]).toMatchObject({ verdict: 'ignored', reason: 'no-next-step', triggerId: 'trg2' })
    expect(records[1]).not.toHaveProperty('wouldAccept')
    expect(log.stats()).toMatchObject({ written: 2, failed: 0 })
  })

  it('never truncates an existing file', () => {
    const dir = tempDir()
    const path = join(dir, 'decisions.jsonl')
    writeFileSync(path, '{"verdict":"ignored","reason":"earlier-run","threadKey":"patrol:old"}\n', 'utf8')

    new DecisionLog({ path }).append(decision())

    const records = lines(path).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(2)
    expect(records[0]!.reason).toBe('earlier-run')
  })

  it('creates a missing directory, nested included', () => {
    const dir = tempDir()
    const path = join(dir, 'artifacts', '2026-11-10', 'decisions.jsonl')
    const result = new DecisionLog({ path }).append(decision())

    expect(result.ok).toBe(true)
    expect(readFileSync(path, 'utf8').trim().endsWith('}')).toBe(true)
  })

  it('keeps reporting a failed append without throwing', () => {
    const dir = tempDir()
    // A directory where the file should be: appendFileSync fails with EISDIR (or EPERM) there.
    const path = join(dir, 'blocked.jsonl')
    mkdirSync(path)

    const errors: Error[] = []
    const log = new DecisionLog({ path, onError: (error) => errors.push(error) })
    const failed = log.append(decision())
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toBeInstanceOf(Error)
    expect(errors).toHaveLength(1)
    expect(log.stats()).toMatchObject({ written: 0, failed: 1 })
  })

  it('resolves a relative path against the given cwd', () => {
    const dir = tempDir()
    expect(resolveDecisionLogPath(join('nested', 'decisions.jsonl'), dir)).toBe(resolve(dir, 'nested', 'decisions.jsonl'))
    expect(resolveDecisionLogPath(join(dir, 'decisions.jsonl'), '/somewhere/else')).toBe(join(dir, 'decisions.jsonl'))
  })

  it('writes nothing when decisionLogPath is not configured', async () => {
    const config = Config.parse({ allowAnyRepo: true })
    expect(config.decisionLogPath).toBe('')
    const dir = tempDir()
    expect(createDecisionLog(config, { cwd: dir })).toBeUndefined()

    // The engine still reports its decisions; it just has no log to append them to.
    const seen: string[] = []
    const engine = createEngine(config, { onDecision: (record) => seen.push(record.verdict) })
    engine.receive(trigger('trg1'))
    const summary = await engine.runRound(new Date('2026-11-10T01:00:00.000Z'))
    expect(summary.observed).toBe(1)
    expect(seen).toEqual(['observed'])
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('Engine + DecisionLog', () => {
  it('records every round decision with its round id', async () => {
    const config = Config.parse({ allowAnyRepo: true, decisionLogPath: join(tempDir(), 'decisions.jsonl'), acceptMode: 'observe' })
    const log = createDecisionLog(config)!
    const engine = createEngine(config, { decisionLog: log })
    expect(engine.receive(trigger('trg1'))).toBe(true)
    expect(engine.receive(trigger('trg2'))).toBe(true)

    const summary = await engine.runRound(new Date('2026-11-10T01:00:00.000Z'))
    const records = lines(log.path).map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(records).toHaveLength(2)
    expect(records.map((record) => record['threadKey'])).toEqual(['patrol:rec1', 'patrol:rec1'])
    for (const record of records) expect(record['roundId']).toBe(summary.roundId)
    expect(records.every((record) => record['verdict'] === 'observed')).toBe(true)
    expect(records[0]!['wouldAccept']).toMatchObject({ title: '示例方向' })
  })
})
