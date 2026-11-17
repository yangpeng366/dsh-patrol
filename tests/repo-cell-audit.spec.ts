/**
 * The repo-cell audit: three states for a `仓库路径` cell, and a gate that can say "no".
 *
 * The unit half injects `inspectRepoPath()` so every cell shape the table actually has can be
 * asserted without a fixture tree. The CLI half runs the real script over a real temp directory
 * and a real two-repo cell, because the one thing a fake cannot prove is that the script's own
 * argument handling, dump reading and exit code line up with what the docs tell a human to run.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { cellText, fixActionOf, parseArgs, parseDump, newestDump, renderReport, exitCodeFor, FIX_ACTIONS } from '../scripts/repo-cell-audit.mjs'
import { inspectRepoPath } from '../src/core/repo-facts.ts'

const script = fileURLToPath(new URL('../scripts/repo-cell-audit.mjs', import.meta.url))

/** A stand-in for `inspectRepoPath()`: a tiny fake filesystem plus the real parser. */
function fakeProbe(existing: string[]) {
  const known = new Set(existing.map((path) => path.toLowerCase()))
  return (path: string) => (known.has(path.toLowerCase()) ? { kind: 'directory' as const } : { kind: 'missing' as const })
}

const PROBE = fakeProbe(['D:\\gitAll\\alpha', 'D:\\gitAll\\beta', 'D:\\gitAll\\trailing'])

function audit(rows: Record<string, unknown>[]) {
  return import('../scripts/repo-cell-audit.mjs').then((mod) =>
    mod.auditCells(rows, { inspect: inspectRepoPath, probe: PROBE }),
  )
}

describe('auditCells', () => {
  it('calls a bare path pure and a tidy-only difference normalized', async () => {
    const report = await audit([
      { record_id: 'recA', 项目名: 'alpha', 仓库路径: 'D:\\gitAll\\alpha' },
      { record_id: 'recB', 项目名: 'beta', 仓库路径: 'd:\\gitAll\\beta\\' },
      { record_id: 'recC', 项目名: 'trailing', 仓库路径: 'D:/gitAll/trailing' },
    ])
    expect(report.total).toBe(3)
    expect(report.pure).toBe(1)
    expect(report.normalized).toBe(2)
    expect(report.offenders).toEqual([])
    expect(report.tally).toEqual([{ reason: 'repo-exists-ok', count: 3 }])
  })

  it('names the two-repo cell instead of counting it as one repo', async () => {
    const report = await audit([{ record_id: 'recTwo', 项目名: '两仓', 仓库路径: 'D:\\gitAll\\alpha + D:\\gitAll\\beta' }])
    expect(report.pure).toBe(0)
    expect(report.offenders).toHaveLength(1)
    expect(report.offenders[0]?.reason).toBe('repo-path-ambiguous')
    expect(report.offenders[0]?.candidates.map((c: { path: string }) => c.path)).toEqual(['D:\\gitAll\\alpha', 'D:\\gitAll\\beta'])
  })

  it('reads a labelled multi-source cell as real candidates, not as `unresolved` labels', async () => {
    const report = await audit([
      { record_id: 'recLabelled', 项目名: '多源', 仓库路径: '前端: D:\\gitAll\\alpha; 后端 (GitCode): D:\\gitAll\\beta' },
    ])
    const row = report.offenders[0]
    expect(row?.reason).toBe('repo-path-ambiguous')
    expect(row?.candidates.map((c: { path: string }) => c.path)).toEqual(['D:\\gitAll\\alpha', 'D:\\gitAll\\beta'])
    expect(row?.candidates.map((c: { kind: string }) => c.kind)).toEqual(['directory', 'directory'])
    expect(row?.candidates.map((c: { label?: string }) => c.label)).toEqual(['前端', '后端 (GitCode)'])
  })

  it('keeps every non-directory shape as an offender with its own reason', async () => {
    const report = await audit([
      { record_id: 'recEmpty', 项目名: '空', 仓库路径: [] },
      { record_id: 'recGone', 项目名: '没有', 仓库路径: 'D:\\gitAll\\gone' },
      { record_id: 'recNote', 项目名: '注记', 仓库路径: 'D:\\gitAll\\alpha（门禁）' },
      { record_id: 'recUrl', 项目名: '未克隆', 仓库路径: '（未克隆）https://github.com/x/y' },
    ])
    expect(report.offenders.map((row: { reason: string }) => row.reason)).toEqual([
      'repo-empty-cell',
      'repo-missing',
      'repo-path-ambiguous',
      'repo-not-cloned',
    ])
    expect(Object.fromEntries(report.tally.map((row: { reason: string; count: number }) => [row.reason, row.count]))).toEqual({
      'repo-empty-cell': 1,
      'repo-missing': 1,
      'repo-path-ambiguous': 1,
      'repo-not-cloned': 1,
    })
  })

  it('refuses to run without the Gate\'s inspector', async () => {
    const mod = await import('../scripts/repo-cell-audit.mjs')
    expect(() => mod.auditCells([], {})).toThrow(/inspectRepoPath/)
  })
})

describe('fix actions', () => {
  it('maps every refusal reason the Gate can produce to one human edit', () => {
    const cases: Array<[string, number, string]> = [
      ['repo-empty-cell', 0, 'fill-cell'],
      ['repo-path-relative-unresolved', 1, 'write-absolute-path'],
      ['repo-not-a-directory', 1, 'point-to-directory'],
      ['repo-not-cloned', 0, 'clone-repo'],
      ['repo-not-local-path', 0, 'clone-repo'],
      ['repo-missing', 1, 'restore-path'],
      ['repo-path-unreachable', 1, 'restore-path'],
    ]
    for (const [reason, candidates, expected] of cases) {
      const fact = { reason, candidates: Array.from({ length: candidates }, () => ({ path: 'D:\\gitAll\\alpha' })) }
      expect(fixActionOf(fact), reason).toBe(expected)
    }
    // Every action a fact can name has a line of prose, so the report never prints an empty column.
    for (const prose of Object.values(FIX_ACTIONS)) expect(prose).not.toBe('')
  })

  it('splits `repo-path-ambiguous` by what the cell actually contains', () => {
    const twoPaths = { reason: 'repo-path-ambiguous', candidates: [{ path: 'D:\\a' }, { path: 'D:\\b' }] }
    const onePathWithNote = { reason: 'repo-path-ambiguous', candidates: [{ path: 'D:\\a', annotation: '（门禁）' }] }
    expect(fixActionOf(twoPaths)).toBe('split-cell')
    expect(fixActionOf(onePathWithNote)).toBe('drop-annotation')
  })

  it('counts offenders by action and keeps the reason tally unchanged', async () => {
    const report = await audit([
      { record_id: 'recEmpty', 项目名: '空', 仓库路径: [] },
      { record_id: 'recGone', 项目名: '没有', 仓库路径: 'D:\\gitAll\\gone' },
      { record_id: 'recNote', 项目名: '注记', 仓库路径: 'D:\\gitAll\\alpha（门禁）' },
      { record_id: 'recTwo', 项目名: '两仓', 仓库路径: 'D:\\gitAll\\alpha + D:\\gitAll\\beta' },
      { record_id: 'recUrl', 项目名: '未克隆', 仓库路径: '（未克隆）https://github.com/x/y' },
    ])
    expect(report.offenders.map((row: { action: string }) => row.action)).toEqual([
      'fill-cell',
      'restore-path',
      'drop-annotation',
      'split-cell',
      'clone-repo',
    ])
    expect(report.byAction).toEqual([
      { action: 'clone-repo', count: 1 },
      { action: 'drop-annotation', count: 1 },
      { action: 'fill-cell', count: 1 },
      { action: 'restore-path', count: 1 },
      { action: 'split-cell', count: 1 },
    ])
    // A report that only tallied actions would lose the refusal vocabulary the log shares.
    expect(report.tally.map((row: { reason: string }) => row.reason)).toContain('repo-path-ambiguous')
  })

  it('prints the action block and the action on each offender line', async () => {
    const dirty = await audit([
      { record_id: 'recTwo', 项目名: '两仓', 仓库路径: 'D:\\gitAll\\alpha + D:\\gitAll\\beta' },
      { record_id: 'recEmpty', 项目名: '空', 仓库路径: [] },
    ])
    const text = renderReport(dirty, 'dump.ndjson')
    expect(text).toContain('--- what has to change, by action ---')
    expect(text).toMatch(/\s2\s+split-cell|\s1\s+split-cell/)
    expect(text).toContain('recTwo | 两仓 | repo-path-ambiguous | split-cell |')
    expect(text).toContain('recEmpty | 空 | repo-empty-cell | fill-cell |')
  })
})

describe('strict gate and report', () => {
  it('only fails on --strict, and only when a cell is an offender', async () => {
    const clean = await audit([{ record_id: 'recA', 项目名: 'alpha', 仓库路径: 'D:\\gitAll\\alpha' }])
    const dirty = await audit([{ record_id: 'recTwo', 项目名: '两仓', 仓库路径: 'D:\\gitAll\\alpha + D:\\gitAll\\beta' }])
    expect(exitCodeFor(clean, false)).toBe(0)
    expect(exitCodeFor(clean, true)).toBe(0)
    expect(exitCodeFor(dirty, false)).toBe(0)
    expect(exitCodeFor(dirty, true)).toBe(1)
  })

  it('prints the offender with its record id, raw cell and candidates', async () => {
    const dirty = await audit([{ record_id: 'recTwo', 项目名: '两仓', 仓库路径: 'D:\\gitAll\\alpha + D:\\gitAll\\beta' }])
    const text = renderReport(dirty, 'dump.ndjson')
    expect(text).toContain('rows=1  pure=0  normalized=0  offenders=1')
    expect(text).toContain('recTwo | 两仓 | repo-path-ambiguous')
    expect(text).toContain('"D:\\\\gitAll\\\\beta" directory')
  })

  it('prints the source label in front of each labelled candidate', async () => {
    const dirty = await audit([
      { record_id: 'recLabelled', 项目名: '多源', 仓库路径: '前端: D:\\gitAll\\alpha; 后端: D:\\gitAll\\beta' },
    ])
    const text = renderReport(dirty, 'dump.ndjson')
    expect(text).toContain('前端 → "D:\\\\gitAll\\\\alpha" directory')
    expect(text).not.toContain('unresolved')
  })
})

describe('input handling', () => {
  it('joins array cells and blank-ish cells the way the dump shapes them', () => {
    expect(cellText(['D:\\a'])).toBe('D:\\a')
    expect(cellText(null)).toBe('')
    expect(cellText([null, 'D:\\a'])).toBe('D:\\a')
  })

  it('parses a BOM-prefixed dump and skips blank lines', () => {
    const rows = parseDump('\uFEFF{"record_id":"a"}\n\n{"record_id":"b"}\n')
    expect(rows.map((row) => row['record_id'])).toEqual(['a', 'b'])
  })

  it('defaults to nothing but a report, and rejects a flag it does not know', () => {
    expect(parseArgs([])).toEqual({ file: undefined, json: false, strict: false })
    expect(parseArgs(['--strict', '--file', 'x.ndjson'])).toMatchObject({ strict: true, file: 'x.ndjson' })
    expect(() => parseArgs(['--file'])).toThrow(/needs a path/)
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/)
  })

  it('returns no dump for a directory that does not exist', () => {
    expect(newestDump(join(tmpdir(), 'dsh-patrol-no-such-dir'))).toBeUndefined()
  })
})

describe('cli', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-cell-audit-'))
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  mkdirSync(alpha)
  mkdirSync(beta)

  const dumpOf = (rows: unknown[]): string => {
    const path = join(root, `dump-${Math.random().toString(16).slice(2)}.ndjson`)
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    return path
  }

  it('exits 0 on a single-repo dump and prints the tally', () => {
    const dump = dumpOf([{ record_id: 'recA', 项目名: 'alpha', 仓库路径: alpha }])
    const result = spawnSync(process.execPath, [script, '--file', dump], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('rows=1  pure=1  normalized=0  offenders=0')
  })

  it('exits 1 on --strict when a cell still writes two repos', () => {
    const dump = dumpOf([{ record_id: 'recTwo', 项目名: '两仓', 仓库路径: `${alpha} + ${beta}` }])
    const result = spawnSync(process.execPath, [script, '--file', dump, '--strict'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('repo-path-ambiguous')
  })

  it('prints JSON when asked, and refuses a missing dump with exit 2', () => {
    const dump = dumpOf([{ record_id: 'recA', 项目名: 'alpha', 仓库路径: alpha }])
    const json = spawnSync(process.execPath, [script, '--file', dump, '--json'], { encoding: 'utf8' })
    expect(json.status).toBe(0)
    expect(JSON.parse(json.stdout).pure).toBe(1)

    const missing = spawnSync(process.execPath, [script, '--file', join(root, 'nope.ndjson')], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('cannot read')
  })
})
