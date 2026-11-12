/**
 * The audit script is a CLI, so the test runs the CLI: same file, same flags, same output the
 * README tells a human to run. Nothing here imports the script's internals.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/policy-audit.mjs', import.meta.url))

interface AuditJson {
  file: string
  total: number
  badLines: { line: number; error: string; text: string }[]
  verdicts: Record<string, number>
  reasons: Record<string, number>
  wouldAccept: { line: number; threadKey: string | null; title: string | null; scope: string | null; rules: string[]; reason: string }[]
  stopped: { line: number; recordId: string | null; intervalMin: number | null; stoppedSince: string | null; reason: string }[]
  stoppedState: { count: number; fingerprint: string; lastEvent: string | null }
}

function jsonl(lines: (object | string)[]): string {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
}

function run(content: string, args: string[] = []): { stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patrol-audit-'))
  const file = join(dir, 'decisions.jsonl')
  writeFileSync(file, content, 'utf8')
  const result = spawnSync(process.execPath, [script, '--file', file, ...args], { encoding: 'utf8' })
  return { stdout: result.stdout, status: result.status }
}

const FILE_UNDER_TEST = [
  { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'observed', reason: 'held-by-mode:observe', threadKey: 'patrol:rec1', triggerId: 'trg1', evalId: 'eval_1', wouldAccept: { title: '示例方向', scope: 'D:\\gitAll\\demo', rules: ['next-step-present'] } },
  { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'observed', reason: 'held-by-mode:observe', threadKey: 'patrol:rec2', triggerId: 'trg2', evalId: 'eval_2' },
  { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'ignored', reason: 'read-only-direction', threadKey: 'patrol:rec3', triggerId: 'trg3', evalId: 'eval_3' },
  { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'ignored', reason: 'needs-approval', threadKey: 'patrol:rec4', triggerId: 'trg4', evalId: 'eval_4' },
  { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'unavailable', reason: 'model-timeout', threadKey: 'patrol:rec5', triggerId: 'trg5', evalId: 'eval_5' },
]

describe('policy-audit', () => {
  it('counts records by verdict and by reason', () => {
    const result = run(jsonl(FILE_UNDER_TEST), ['--json'])
    expect(result.status).toBe(0)
    const audit = JSON.parse(result.stdout) as AuditJson

    expect(audit.total).toBe(5)
    expect(audit.badLines).toEqual([])
    expect(audit.verdicts).toMatchObject({ admitted: 0, observed: 2, ignored: 2, unavailable: 1 })
    expect(audit.reasons).toMatchObject({ 'held-by-mode:observe': 2, 'read-only-direction': 1, 'needs-approval': 1, 'model-timeout': 1 })
  })

  it('lists only the entries that carry a would-accept payload', () => {
    const audit = JSON.parse(run(jsonl(FILE_UNDER_TEST), ['--json']).stdout) as AuditJson

    expect(audit.wouldAccept).toHaveLength(1)
    expect(audit.wouldAccept[0]).toMatchObject({
      line: 1,
      threadKey: 'patrol:rec1',
      title: '示例方向',
      scope: 'D:\\gitAll\\demo',
      rules: ['next-step-present'],
      reason: 'held-by-mode:observe',
    })
  })

  it('lists stopped rows by record id and the interval the table wrote', () => {
    const content = jsonl([
      FILE_UNDER_TEST[0]!,
      // Written by `Engine.recordStoppedSet()`: a row whose 巡检间隔 is 0 never reaches the Gate, but it
      // still lands in the log, so "which rows are stopped" is a query, not an archaeology dig.
      { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_20261110T010000Z_1', verdict: 'stopped', reason: 'schedule-stopped', threadKey: 'patrol:recStop', recordId: 'recStop', intervalMin: 0, triggerId: 'trg_recStop_abc', evalId: 'eval_9' },
    ])
    const result = run(content, ['--json'])
    expect(result.status).toBe(0)
    const audit = JSON.parse(result.stdout) as AuditJson
    expect(audit.verdicts).toMatchObject({ admitted: 0, observed: 1, stopped: 1, ignored: 0, unavailable: 0 })
    expect(audit.stopped).toEqual([
      expect.objectContaining({ line: 2, recordId: 'recStop', intervalMin: 0, reason: 'schedule-stopped' }),
    ])
    // A stopped row is not a held-back accept: it must not leak into the would-accept list.
    expect(audit.wouldAccept).toHaveLength(1)

    const human = run(content)
    expect(human.stdout).toContain('stopped rows (recorded, not dispatched): 1')
    expect(human.stdout).toContain('recStop')
    expect(human.stdout).toContain('巡检间隔=0')
  })

  it('replays snapshot, deltas and heartbeat into the current stopped rows', () => {
    const content = jsonl([
      { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_1', verdict: 'stopped', reason: 'schedule-stopped', stoppedEvent: 'snapshot', stoppedCount: 2, stoppedFingerprint: 'old', stoppedSince: '2026-11-09T20:00:00.000Z', threadKey: 'patrol:recA', recordId: 'recA', intervalMin: 0, triggerId: 'trgA', evalId: 'evalA' },
      { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_1', verdict: 'stopped', reason: 'schedule-stopped', stoppedEvent: 'snapshot', stoppedCount: 2, stoppedFingerprint: 'old', threadKey: 'patrol:recB', recordId: 'recB', intervalMin: 0, triggerId: 'trgB', evalId: 'evalB' },
      { ts: '2026-11-10T02:00:00.000Z', roundId: 'rnd_2', verdict: 'stopped', reason: 'schedule-stopped', stoppedEvent: 'removed', stoppedCount: 1, stoppedFingerprint: 'middle', threadKey: 'patrol:recB', recordId: 'recB', intervalMin: 0, triggerId: 'trgB', evalId: 'evalB' },
      { ts: '2026-11-10T03:00:00.000Z', roundId: 'rnd_3', verdict: 'stopped', reason: 'schedule-stopped', stoppedEvent: 'added', stoppedCount: 2, stoppedFingerprint: 'current', threadKey: 'patrol:recC', recordId: 'recC', intervalMin: 0, triggerId: 'trgC', evalId: 'evalC' },
      { ts: '2026-11-10T04:00:00.000Z', roundId: 'rnd_4', verdict: 'stopped', reason: 'schedule-stopped', stoppedEvent: 'heartbeat', stoppedCount: 2, stoppedFingerprint: 'current', threadKey: 'stopped-set', triggerId: 'stopped-set', evalId: 'eval_stopped_set' },
    ])

    const audit = JSON.parse(run(content, ['--json']).stdout) as AuditJson
    expect(audit.stopped.map((entry) => entry.recordId)).toEqual(['recA', 'recC'])
    expect(audit.stoppedState).toMatchObject({ count: 2, lastEvent: 'heartbeat' })
    // First-seen time survives replay; a line without it reports null rather than guessing.
    expect(audit.stopped.map((entry) => entry.stoppedSince)).toEqual(['2026-11-09T20:00:00.000Z', null])
  })

  it('uses the latest legacy round as the current stopped set', () => {
    const content = jsonl([
      { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_1', verdict: 'stopped', reason: 'schedule-stopped', threadKey: 'patrol:recA', recordId: 'recA', intervalMin: 0, triggerId: 'trgA', evalId: 'evalA' },
      { ts: '2026-11-10T01:00:00.000Z', roundId: 'rnd_1', verdict: 'stopped', reason: 'schedule-stopped', threadKey: 'patrol:recB', recordId: 'recB', intervalMin: 0, triggerId: 'trgB', evalId: 'evalB' },
      { ts: '2026-11-10T02:00:00.000Z', roundId: 'rnd_2', verdict: 'stopped', reason: 'schedule-stopped', threadKey: 'patrol:recA', recordId: 'recA', intervalMin: 0, triggerId: 'trgA', evalId: 'evalA' },
    ])

    const audit = JSON.parse(run(content, ['--json']).stdout) as AuditJson
    expect(audit.stopped.map((entry) => entry.recordId)).toEqual(['recA'])
    expect(audit.stoppedState).toMatchObject({ count: 1, lastEvent: 'legacy' })
  })

  it('reports bad lines with their line numbers and keeps counting the good ones', () => {
    const content = jsonl([
      FILE_UNDER_TEST[0]!,
      '{"verdict":"observed",',                 // line 2: truncated JSON
      '[1,2,3]',                                // line 3: valid JSON, not an object
      '{"threadKey":"patrol:rec9","reason":"x"}', // line 4: no verdict
      '',                                       // line 5: blank, not an error
      FILE_UNDER_TEST[2]!,                      // line 6
    ])
    const result = run(content, ['--json'])

    expect(result.status).toBe(0)
    const audit = JSON.parse(result.stdout) as AuditJson
    expect(audit.total).toBe(2)
    expect(audit.badLines.map((bad) => bad.line)).toEqual([2, 3, 4])
    expect(audit.badLines[0]!.error).toContain('invalid JSON')
    expect(audit.badLines[1]!.error).toContain('not a JSON object')
    expect(audit.badLines[2]!.error).toContain('verdict')
    expect(audit.verdicts).toMatchObject({ observed: 1, ignored: 1 })
    expect(audit.wouldAccept).toHaveLength(1)
  })

  it('prints a readable summary by default, bad lines included', () => {
    const content = jsonl([FILE_UNDER_TEST[0]!, 'not json at all'])
    const result = run(content)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('records: 1  (bad lines: 1)')
    expect(result.stdout).toContain('by verdict:')
    expect(result.stdout).toContain('by reason:')
    expect(result.stdout).toContain('would-accept (held for review): 1')
    expect(result.stdout).toContain('示例方向')
    expect(result.stdout).toContain('line 2: invalid JSON')
  })

  it('fails with a usage message when --file is missing', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--file is required')
  })

  it('fails with exit code 1 when the file cannot be read', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'dsh-patrol-audit-')), 'nope.jsonl')
    const result = spawnSync(process.execPath, [script, '--file', missing], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read')
  })
})
