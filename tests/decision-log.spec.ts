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
      facts: { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 60, repoPath: 'D:\\gitAll\\demo', repoExists: { raw: 'D:\\gitAll\\demo', exists: true, kind: 'directory', normalizedPath: 'D:\\gitAll\\demo', reason: 'repo-exists-ok', candidates: [] }, actionFacts: { kind: 'repo-code', source: 'text', matched: ['实现'], evidence: '把下一步做完', field: '下一步', reason: '仓内动作', alternatives: [] } },
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

  it('writes a stopped record as a decision, with the row id and the interval the table wrote', () => {
    const dir = tempDir()
    const path = join(dir, 'decisions.jsonl')
    const log = new DecisionLog({ path, now: () => new Date('2026-11-10T01:00:00.000Z') })
    // What `Engine.recordStopped()` emits: a verdict of its own, the Policy's reason, and the two
    // facts an audit needs to answer "which row is stopped, and why did nothing run".
    log.append(decision({
      verdict: 'stopped',
      reason: 'schedule-stopped',
      wouldAccept: undefined,
      recordId: 'recStop',
      intervalMin: 0,
    }))

    const [record] = lines(path).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(record).toMatchObject({ verdict: 'stopped', reason: 'schedule-stopped', recordId: 'recStop', intervalMin: 0 })
    expect(record).not.toHaveProperty('wouldAccept')
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
    // "Written down or inferred" travels with the decision, so a log reader can tell a column fact
    // from a reading of prose without going back to the table.
    expect(records[0]!['actionSource']).toBe('text')
    // The row's identity and its own interval travel too: `stopped` records are only readable if the
    // line says which row and what 巡检间隔 was.
    expect(records[0]!['recordId']).toBe('rec1')
    expect(records[0]!['intervalMin']).toBe(60)
  })

  it('marks a decision whose action kind came from the 动作类型 column', async () => {
    const config = Config.parse({ allowAnyRepo: true, decisionLogPath: join(tempDir(), 'decisions.jsonl'), acceptMode: 'observe' })
    const log = createDecisionLog(config)!
    const engine = createEngine(config, { decisionLog: log })
    const fromColumn = trigger('trg3')
    const facts = fromColumn.meta['facts'] as Record<string, unknown>
    facts['actionFacts'] = { kind: 'repo-code', source: 'column', matched: [], evidence: 'repo-code', field: '动作类型', reason: '列值', alternatives: [] }
    engine.receive(fromColumn)

    await engine.runRound(new Date('2026-11-10T01:00:00.000Z'))
    const records = lines(log.path).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records[0]!['actionSource']).toBe('column')
  })
})
