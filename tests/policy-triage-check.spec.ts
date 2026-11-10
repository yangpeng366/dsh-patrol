/**
 * The triage checker as a CLI, the way the doc tells a human to run it: same file, same flags.
 *
 * The fixtures are deliberately tiny — two records, one running and one stopped — because what is
 * under test is not the real table but the four judgements the checker makes about the document:
 * coverage, vocabulary, the structured part of the 口径, and the published counts.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/policy-triage-check.mjs', import.meta.url))

const DECISIONS = [
  { ts: '2026-11-10T14:51:24.984Z', verdict: 'observed', reason: 'held-by-mode:observe', threadKey: 'patrol:recRun', triggerId: 'trg_recRun_aaa', wouldAccept: { title: '在跑的行', scope: 'D:\\gitAll\\run', rules: ['next-step-present'] } },
  { ts: '2026-11-10T14:51:24.985Z', verdict: 'observed', reason: 'held-by-mode:observe', threadKey: 'patrol:recStop', triggerId: 'trg_recStop_bbb', wouldAccept: { title: '停跑的行', scope: 'D:\\gitAll\\stop', rules: ['next-step-present'] } },
  { ts: '2026-11-10T14:51:24.986Z', verdict: 'ignored', reason: 'read-only-direction', threadKey: 'patrol:recOther', triggerId: 'trg_recOther_ccc' },
].map((line) => JSON.stringify(line)).join('\n')

const TABLE = [
  { record_id: 'recRun', 项目名: '在跑的行', '巡检间隔(分钟)': [60], 授权边界: ['自主'], 审批状态: [], 下一步: '补一个单测', 仓库路径: 'D:\\gitAll\\run' },
  { record_id: 'recStop', 项目名: '停跑的行', '巡检间隔(分钟)': [0], 授权边界: ['自主'], 审批状态: [], 下一步: '发布新版本', 仓库路径: 'D:\\gitAll\\stop' },
].map((row) => JSON.stringify(row)).join('\n')

const HEADER = '| # | record_id | 项目名 | scope | 当前阶段 | 巡检间隔 | 授权边界 | 最近结果 | 判定 | 判据 |'
const RULE = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
const REPO_HEADER = '| # | record_id | 项目名 | 仓库路径（原始单元格） | exists | kind | reason |'
const REPO_RULE = '| --- | --- | --- | --- | --- | --- | --- |'

/** The §6.1 repo table + blocks, built from the dump's cells (both fixtures are not on disk). */
function repoSection(options: { rows?: string[]; summary?: string; table?: boolean; tally?: string[] | null } = {}): string[] {
  const rows = options.rows ?? [
    '| 1 | `recRun` | 在跑的行 | `D:\\gitAll\\run` | false | missing | repo-missing |',
    '| 2 | `recStop` | 停跑的行 | `D:\\gitAll\\stop` | false | missing | repo-missing |',
  ]
  const summary = options.summary ?? ['candidates=2', 'reason-repo-missing=2', 'still-auto=0'].join('\n')
  const tally = options.tally === undefined ? ['records=2', 'reason-repo-missing=2'] : options.tally
  return [
    '', '## 6.1 repo-exists', '',
    ...(options.table === false ? [] : [REPO_HEADER, REPO_RULE, ...rows]),
    '', '```triage-repo-exists', summary, '```',
    ...(tally === null ? [] : ['', '```triage-repo-tally', ...tally, '```']),
  ]
}

function doc(options: { rows?: string[]; summary?: string; repo?: string[]; action?: string[] | null } = {}): string {
  const rows = options.rows ?? [
    '| 1 | `recRun` | 在跑的行 | D:\\gitAll\\run | 开发 | 60 | 自主 | 成功 | **approval** | 下一步要发版 |',
    '| 2 | `recStop` | 停跑的行 | D:\\gitAll\\stop | 维护 | 0 | 自主 | （空） | **excluded** | 停跑 |',
  ]
  const summary = options.summary ?? [
    'total=2', 'auto=0', 'approval=1', 'read-only=0', 'excluded=1',
    'replay-v1-schedule-stopped=1', 'replay-v1-would-accept=1',
  ].join('\n')
  // The fixture rows are `补一个单测` (repo-test) and `发布新版本` (release).
  const action = options.action === undefined ? ['records=2', 'kind-repo-test=1', 'kind-release=1'] : options.action
  return ['# 逐条定性', '', HEADER, RULE, ...rows, '', '```triage-summary', summary, '```', ...(options.repo ?? []), ...(action === null ? [] : ['', '```triage-action', ...action, '```'])].join('\n')
}

function run(options: { markdown?: string; decisons?: string; table?: string } = {}): { stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patrol-triage-'))
  const docPath = join(dir, 'triage.md')
  const logPath = join(dir, 'decisions.jsonl')
  const tablePath = join(dir, 'table.ndjson')
  writeFileSync(docPath, options.markdown ?? doc(), 'utf8')
  writeFileSync(logPath, options.decisons ?? DECISIONS, 'utf8')
  writeFileSync(tablePath, options.table ?? TABLE, 'utf8')
  const result = spawnSync(process.execPath, [script, '--doc', docPath, '--file', logPath, '--table', tablePath, '--replay-file', join(dir, 'no-replay-log.jsonl')], { encoding: 'utf8' })
  return { stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status }
}

describe('policy-triage-check', () => {
  it('passes when the document agrees with the log, the table and its own summary', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ok   table:coverage: 2 rows for 2 would-accept records')
    expect(result.stdout).toContain('ok   table:verdicts')
    expect(result.stdout).toContain('ok   table:structure')
    expect(result.stdout).toContain('ok   summary:counts')
    expect(result.stdout).toContain('RESULT: PASS')
  })

  it('fails when a would-accept record has no row in the document', () => {
    const markdown = doc({ rows: ['| 1 | `recRun` | 在跑的行 | D:\\gitAll\\run | 开发 | 60 | 自主 | 成功 | **approval** | 下一步要发版 |'] })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL table:coverage')
    expect(result.stdout).toContain('missing: recStop')
  })

  it('fails when the document names a record the log never judged', () => {
    const markdown = doc({
      rows: [
        '| 1 | `recRun` | 在跑的行 | D:\\gitAll\\run | 开发 | 60 | 自主 | 成功 | **approval** | 下一步要发版 |',
        '| 2 | `recStop` | 停跑的行 | D:\\gitAll\\stop | 维护 | 0 | 自主 | （空） | **excluded** | 停跑 |',
        '| 3 | `recGhost` | 不存在的行 | D:\\gitAll\\ghost | 开发 | 60 | 自主 | （空） | **auto** | 无 |',
      ],
    })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('not in the log: recGhost')
  })

  it('fails when a stopped row is judged auto (the 口径 is not a suggestion)', () => {
    const markdown = doc({
      rows: [
        '| 1 | `recRun` | 在跑的行 | D:\\gitAll\\run | 开发 | 60 | 自主 | 成功 | **approval** | 下一步要发版 |',
        '| 2 | `recStop` | 停跑的行 | D:\\gitAll\\stop | 维护 | 0 | 自主 | （空） | **auto** | 停跑 |',
      ],
      summary: ['total=2', 'auto=1', 'approval=1', 'read-only=0', 'excluded=0', 'replay-v1-schedule-stopped=1', 'replay-v1-would-accept=1'].join('\n'),
    })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL table:structure')
    expect(result.stdout).toContain('口径 forces excluded, doc says auto')
  })

  it('fails when a 只读 row is judged approval without the excluded reason', () => {
    const readOnlyTable = [
      { record_id: 'recRun', 项目名: '只读的行', '巡检间隔(分钟)': [60], 授权边界: ['只读'], 审批状态: [], 下一步: '通读协议', 仓库路径: 'D:\\gitAll\\run' },
      { record_id: 'recStop', 项目名: '停跑的行', '巡检间隔(分钟)': [0], 授权边界: ['自主'], 审批状态: [], 下一步: '发布新版本', 仓库路径: 'D:\\gitAll\\stop' },
    ].map((row) => JSON.stringify(row)).join('\n')
    const result = run({ table: readOnlyTable })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL table:structure')
    expect(result.stdout).toContain('recRun: 口径 forces read-only, doc says approval')
  })

  it('fails when the summary block disagrees with the rows', () => {
    const markdown = doc({
      summary: ['total=2', 'auto=0', 'approval=2', 'read-only=0', 'excluded=0', 'replay-v1-schedule-stopped=1', 'replay-v1-would-accept=1'].join('\n'),
    })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL summary:counts')
    expect(result.stdout).toContain('excluded: doc 0, derived 1')
  })

  it('fails when a verdict is outside the vocabulary', () => {
    const markdown = doc({
      rows: [
        '| 1 | `recRun` | 在跑的行 | D:\\gitAll\\run | 开发 | 60 | 自主 | 成功 | **approve** | 拼错 |',
        '| 2 | `recStop` | 停跑的行 | D:\\gitAll\\stop | 维护 | 0 | 自主 | （空） | **excluded** | 停跑 |',
      ],
    })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    // A misspelled verdict does not parse as a verdict cell, so the row itself goes missing.
    expect(result.stdout).toContain('FAIL table:coverage')
  })

  it('fails loudly when the document or the log cannot be read', () => {
    const result = spawnSync(process.execPath, [script, '--doc', join(tmpdir(), 'nope-triage.md')], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('cannot read')
  })

  it('recomputes repo-exists row by row and checks its own counts', () => {
    const result = run({ markdown: doc({ repo: repoSection() }) })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ok   repo:table: 2/2 rows recomputed with src/core/repo-facts.ts')
    expect(result.stdout).toContain('ok   repo:counts')
    expect(result.stdout).toContain('ok   repo:tally')
    expect(result.stdout).toContain('recRun  exists=false missing   repo-missing')
  })

  it('fails when the doc claims a repo where the dump says the path is not there', () => {
    const markdown = doc({
      repo: repoSection({
        rows: [
          '| 1 | `recRun` | 在跑的行 | `D:\\gitAll\\run` | true | directory | repo-exists-ok |',
          '| 2 | `recStop` | 停跑的行 | `D:\\gitAll\\stop` | false | missing | repo-missing |',
        ],
        summary: ['candidates=2', 'reason-repo-exists-ok=1', 'reason-repo-missing=1', 'still-auto=1'].join('\n'),
        tally: ['records=2', 'reason-repo-exists-ok=1', 'reason-repo-missing=1'],
      }),
    })
    const result = run({ markdown })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL repo:table')
    expect(result.stdout).toContain('recRun: exists doc true, computed false')
  })

  it('fails when the repo table has no machine-readable block (the numbers must be published)', () => {
    const result = run({ markdown: doc({ repo: ['', REPO_HEADER, REPO_RULE, '| 1 | `recRun` | 在跑的行 | `D:\\gitAll\\run` | false | missing | repo-missing |', '| 2 | `recStop` | 停跑的行 | `D:\\gitAll\\stop` | false | missing | repo-missing |'] }) })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL repo:counts')
    expect(result.stdout).toContain('no ```triage-repo-exists block')
  })

  it('fails when the tally block disagrees with the dump', () => {
    const result = run({ markdown: doc({ repo: repoSection({ tally: ['records=2', 'reason-repo-missing=1'] }) }) })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL repo:tally')
    expect(result.stdout).toContain('reason-repo-missing: doc 1, derived 2')
  })

  it('recomputes the action types of every dumped row and checks the published counts', () => {
    const result = run()
    expect(result.stdout).toContain('ok   action:counts')
    // `补一个单测` is repo-test, `发布新版本` is release — the point is that it is measured, not read.
    expect(result.stdout).toContain('repo-test 1')
    expect(result.stdout).toContain('release 1')
  })

  it('fails when the action block disagrees with the dump', () => {
    const result = run({ markdown: doc({ action: ['records=2', 'kind-repo-test=2'] }) })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL action:counts')
    expect(result.stdout).toContain('kind-repo-test: doc 2, derived 1')
  })

  it('fails when the action block is missing although a dump was given', () => {
    const result = run({ markdown: doc({ action: null }) })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL action:counts')
    expect(result.stdout).toContain('no ```triage-action block')
  })

  it('skips the structural checks when no table dump is given, and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patrol-triage-'))
    const docPath = join(dir, 'triage.md')
    const logPath = join(dir, 'decisions.jsonl')
    writeFileSync(docPath, doc(), 'utf8')
    writeFileSync(logPath, DECISIONS, 'utf8')
    const result = spawnSync(process.execPath, [script, '--doc', docPath, '--file', logPath, '--replay-file', join(dir, 'no-replay-log.jsonl')], { encoding: 'utf8' })
    // Without a table the replay keys cannot be derived, which is reported, not failed.
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('note: pass --table')
  })
})
