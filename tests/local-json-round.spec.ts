/**
 * The local-json round: what the Gate held, and how much of it the repo fact accounts for.
 *
 * The unit half pins the arithmetic and the dump conversion — a share computed off the wrong
 * denominator is worse than no number, because it looks like an answer. The integration half runs
 * the real `Engine` under the real `DirectionPolicy` over a real temp directory tree, so
 * `repo-path-ambiguous` and `repo-missing` are produced by the Gate's own probe rather than by a
 * hand-written decision list.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  cellOf,
  isMultiSegment,
  parseArgs,
  percent,
  reasonTally,
  recordFromDumpRow,
  recordsFromDump,
  renderReport,
  repoFactShare,
  runLocalJsonRound,
  AMBIGUOUS_REASONS,
  MISSING_REASONS,
  REPO_FACT_REASONS,
} from '../scripts/local-json-round.ts'
import type { DecisionRecord } from '../src/core/engine.ts'

const script = fileURLToPath(new URL('../scripts/local-json-round.ts', import.meta.url))

/** One decision, only as complete as the tally needs it. */
function decision(verdict: 'ignored' | 'observed' | 'admitted', reason: string, recordId?: string): DecisionRecord {
  return { threadKey: `thread-${recordId ?? reason}`, recordId, verdict, reason, at: '2026-11-19T00:00:00.000Z' } as unknown as DecisionRecord
}

/** A real temp tree with two sibling repos; returns the root. */
function repoTrees(): { root: string; alpha: string; beta: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-json-round-'))
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  mkdirSync(alpha, { recursive: true })
  mkdirSync(beta, { recursive: true })
  return { root, alpha, beta }
}

function localJsonFile(items: Record<string, unknown>[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-local-json-items-')), 'items.json')
  writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
  return file
}

/** A dump line as the direction table exports it: flat, Chinese column names. */
function dumpOf(rows: Record<string, unknown>[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-local-json-dump-')), 'table.ndjson')
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return file
}

describe('percent', () => {
  it('is 0 rather than NaN on an empty denominator', () => {
    expect(percent(0, 0)).toBe(0)
    expect(percent(3, -1)).toBe(0)
  })

  it('keeps one decimal, so a share never reads as a whole percent it is not', () => {
    expect(percent(1, 12)).toBe(8.3)
    expect(percent(2, 3)).toBe(66.7)
    expect(percent(12, 12)).toBe(100)
  })
})

describe('reasonTally', () => {
  it('counts ignored only, most frequent first, ties by reason', () => {
    const tally = reasonTally([
      decision('ignored', 'repo-missing'),
      decision('ignored', 'action-release'),
      decision('ignored', 'repo-missing'),
      decision('observed', 'repo-missing'),
      decision('admitted', 'repo-missing'),
    ])
    expect(tally).toEqual([
      { reason: 'repo-missing', count: 2 },
      { reason: 'action-release', count: 1 },
    ])
  })

  it('is empty when nothing was ignored', () => {
    expect(reasonTally([decision('observed', 'row-carries-next-step')])).toEqual([])
  })
})

describe('repoFactShare', () => {
  it('splits the repo layer into its ambiguous and missing shapes and leaves the rest alone', () => {
    const share = repoFactShare(reasonTally([
      decision('ignored', 'repo-path-ambiguous'),
      decision('ignored', 'repo-path-ambiguous'),
      decision('ignored', 'repo-missing'),
      decision('ignored', 'repo-not-cloned'),
      decision('ignored', 'action-release'),
      decision('ignored', 'action-release'),
      decision('ignored', 'action-release'),
    ]))
    expect(share.ignored).toBe(7)
    expect(share.ambiguous).toBe(2)
    expect(share.missing).toBe(1)
    expect(share.otherRepoFact).toBe(1)
    expect(share.repoFactBlocked).toBe(4)
    expect(share.repoFactShare).toBe(57.1)
    expect(share.ambiguousShare).toBe(28.6)
    expect(share.missingShare).toBe(14.3)
    expect(share.nonRepoFact).toEqual([{ reason: 'action-release', count: 3 }])
  })

  it('does not count the allowlist layer as a repo fact: those rows were never probed', () => {
    const share = repoFactShare([{ reason: 'repo-not-autonomous', count: 5 }])
    expect(share.repoFactBlocked).toBe(0)
    expect(share.repoFactShare).toBe(0)
    expect(share.nonRepoFact).toEqual([{ reason: 'repo-not-autonomous', count: 5 }])
  })

  it('keeps the three published families disjoint, so the shares add up', () => {
    const share = repoFactShare([{ reason: 'repo-empty-cell', count: 2 }])
    expect(share.ambiguous).toBe(0)
    expect(share.missing).toBe(0)
    expect(share.otherRepoFact).toBe(2)
    expect(REPO_FACT_REASONS).toContain('repo-empty-cell')
    expect(AMBIGUOUS_REASONS).toEqual(['repo-path-ambiguous'])
    expect(MISSING_REASONS).toEqual(['repo-missing'])
  })
})

describe('dump conversion', () => {
  it('reads a cell the way the bitable source does: the first segment only', () => {
    expect(cellOf(['D:\\gitAll\\alpha', '注记'])).toBe('D:\\gitAll\\alpha')
    expect(cellOf([''])).toBe('')
    expect(cellOf(null)).toBe('')
    expect(isMultiSegment(['D:\\gitAll\\alpha', '注记'])).toBe(true)
    expect(isMultiSegment(['D:\\gitAll\\alpha', '   '])).toBe(false)
    expect(isMultiSegment('D:\\gitAll\\alpha')).toBe(false)
  })

  it('maps the table columns onto the local-json keys', () => {
    const record = recordFromDumpRow({
      record_id: 'recA',
      项目名: 'alpha',
      简要描述: '说明',
      下一步: '补测试',
      优先级: 'P1',
      '巡检间隔(分钟)': 1440,
      仓库路径: 'D:\\gitAll\\alpha',
      当前阶段: '开发',
      授权边界: '自主',
      协作形态: 'sparse',
      审批状态: '已通过',
      假数据模式: true,
      分类: '兴趣研究',
    })
    expect(record['id']).toBe('recA')
    expect(record['title']).toBe('alpha')
    // Cells are read as text, as the bitable source reads them; `normalizeItem()` is what turns the
    // schedule back into a number, so the conversion must not pre-parse it.
    expect(record['intervalMin']).toBe('1440')
    expect(record['repoPath']).toBe('D:\\gitAll\\alpha')
    expect(record['fake']).toBe(true)
    expect(record['category']).toBe('兴趣研究')
    // A column the dump does not carry becomes blank, never a missing key: `normalizeItem()` reads
    // a missing key and a blank cell differently for `动作类型`.
    expect(record['actionType']).toBe('')
  })

  it('drops a row with no record id and flags the multi-segment repo cells', () => {
    const { records, multiSegment } = recordsFromDump(readFileSync(dumpOf([
      { record_id: 'recA', 项目名: 'a', 仓库路径: 'D:\\one' },
      { record_id: '', 项目名: 'b', 仓库路径: 'D:\\two' },
      { record_id: 'recC', 项目名: 'c', 仓库路径: ['D:\\one + D:\\two', '注记'] },
    ]), 'utf8'))
    expect(records.map((record) => record['id'])).toEqual(['recA', 'recC'])
    expect(records[1]?.['repoPath']).toBe('D:\\one + D:\\two')
    expect(multiSegment).toEqual(['recC'])
  })
})

describe('parseArgs', () => {
  it('defaults to an observe round with no allowlist and no dispatch', () => {
    const options = parseArgs(['--dump'])
    expect(options.dump).toBe('')
    expect(options.acceptMode).toBe('observe')
    expect(options.repos).toEqual([])
    expect(options.anyRepo).toBe(false)
    expect(options.json).toBe(false)
  })

  it('splits the allowlist on both separators and refuses two sources at once', () => {
    expect(parseArgs(['--dump', 'x.ndjson', '--repos', "D:\\a;E:\\b"]).repos).toEqual(['D:\\a', 'E:\\b'])
    expect(() => parseArgs(['--dump', 'x.ndjson', '--tasks-file', 'y.json'])).toThrow(/alternatives/)
    expect(() => parseArgs([])).toThrow(/required/)
    expect(() => parseArgs(['--dump', 'x.ndjson', '--accept-mode', 'maybe'])).toThrow(/off\|observe\|auto/)
    expect(() => parseArgs(['--dump', 'x.ndjson', '--nope'])).toThrow(/unknown argument/)
  })
})

describe('runLocalJsonRound', () => {
  const { root, alpha, beta } = repoTrees()

  it('judges due rows, records stopped rows without judging them, and names the repo layer', async () => {
    const file = localJsonFile([
      { id: 'row-amb', title: '两仓', nextStep: '补一条策略测试', intervalMin: 1440, repoPath: `${alpha} + ${beta}`, actionType: 'repo-test' },
      { id: 'row-gone', title: '缺目录', nextStep: '补一条策略测试', intervalMin: 1440, repoPath: join(root, 'gone'), actionType: 'repo-test' },
      { id: 'row-ok', title: '正常', nextStep: '补一条策略测试', intervalMin: 1440, repoPath: alpha, actionType: 'repo-test' },
      { id: 'row-stopped', title: '停跑', nextStep: '补一条策略测试', intervalMin: 0, repoPath: `${alpha} + ${beta}`, actionType: 'repo-test' },
    ])
    const result = await runLocalJsonRound({ file, anyRepo: true, now: new Date('2026-11-19T00:00:00.000Z') })

    expect(result.counts).toEqual({ rows: 4, due: 3, stopped: 1, notDue: 0 })
    expect(result.summary.evaluated).toBe(3)
    // The Accept path is a stand-in, but it must still produce one: the Gate's job is to be crossable.
    expect(result.summary.observed).toBe(1)
    expect(result.summary.admitted).toBe(0)
    expect(result.summary.tickets).toHaveLength(0)

    const tally = reasonTally(result.decisions)
    expect(tally).toEqual([
      { reason: 'repo-missing', count: 1 },
      { reason: 'repo-path-ambiguous', count: 1 },
    ])
    expect(repoFactShare(tally).repoFactShare).toBe(100)
  })

  it('refuses every row when no allowlist is configured, and says so instead of blaming the repos', async () => {
    const file = localJsonFile([
      { id: 'row-ok', title: '正常', nextStep: '补一条策略测试', intervalMin: 1440, repoPath: alpha, actionType: 'repo-test' },
    ])
    const result = await runLocalJsonRound({ file, now: new Date('2026-11-19T00:00:00.000Z') })
    const tally = reasonTally(result.decisions)
    expect(tally).toEqual([{ reason: 'repo-allowlist-unset', count: 1 }])
    expect(repoFactShare(tally).repoFactBlocked).toBe(0)
  })

  it('renders a report a human can act on: the share, the reason tally, and the offending rows', async () => {
    const file = localJsonFile([
      { id: 'row-amb', title: '两仓', nextStep: '补一条策略测试', intervalMin: 1440, repoPath: `${alpha} + ${beta}`, actionType: 'repo-test' },
    ])
    const result = await runLocalJsonRound({ file, anyRepo: true, now: new Date('2026-11-19T00:00:00.000Z') })
    const tally = reasonTally(result.decisions)
    const report = renderReport({
      source: file,
      policyVersion: 'v5-shadow',
      acceptMode: 'observe',
      repos: [],
      anyRepo: true,
      result,
      tally,
      share: repoFactShare(tally),
    })
    expect(report).toContain('rows=1  due=1  stopped=0  not-due=0')
    expect(report).toContain('repo-fact blocked = 1/1 ignored = 100%')
    expect(report).toContain('row-amb  repo-path-ambiguous')
    expect(report).toContain('allowlist: (any repo: diagnostic opt-in, the allowlist layer is off)')
  })
})

describe('local-json-round CLI', () => {
  const { alpha, beta } = repoTrees()

  it('converts a dump, runs the round, and prints the share', () => {
    const dump = dumpOf([
      {
        record_id: 'recAmb',
        项目名: '两仓',
        下一步: '补一条策略测试',
        '巡检间隔(分钟)': 1440,
        仓库路径: `${alpha} + ${beta}`,
        动作类型: 'repo-test',
        分类: '兴趣研究',
      },
    ])
    const result = spawnSync(process.execPath, [script, '--dump', dump, '--any-repo'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('rows=1  due=1')
    expect(result.stdout).toContain('repo-path-ambiguous')
    expect(result.stdout).toContain('repo-fact blocked = 1/1 ignored = 100%')
  })

  it('prints one JSON object when asked, and exits 2 on an unreadable dump', () => {
    const dump = dumpOf([{ record_id: 'recA', 项目名: 'a', 下一步: '补测试', '巡检间隔(分钟)': 1440, 仓库路径: alpha }])
    const json = spawnSync(process.execPath, [script, '--dump', dump, '--any-repo', '--json'], { encoding: 'utf8' })
    expect(json.status).toBe(0)
    const parsed = JSON.parse(json.stdout) as { share: { ignored: number }; counts: { rows: number }; decisions: { reason: string; recordId?: string }[] }
    expect(parsed.counts.rows).toBe(1)
    expect(parsed.share.ignored).toBeGreaterThanOrEqual(0)
    // The per-row half travels with the tally, so a caller can act on the row a reason names. The
    // round's own stopped-set marker is in there too and is not a row: it carries no `recordId`.
    expect(parsed.decisions.some((entry) => entry.recordId === 'recA')).toBe(true)

    const missing = spawnSync(process.execPath, [script, '--dump', join(tmpdir(), 'no-such-dump.ndjson')], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('cannot read')
  })
})
