/**
 * The rewrite rehearsal: what a rewritten `下一步` does to the action kind, and what the control says.
 *
 * The three C-class rows of `docs/local-json-round.md` are the subject, so the cells here are copied
 * from that table's shape (not its full history) and then shortened to the part that decides the
 * reading. Two properties matter and are pinned separately:
 *
 *   - a rewrite that moves a *site/release/secret* half out of `下一步` flips the prose kind;
 *   - a rewrite that moves a *pending-decision* half into `用户批注` does not, because that field is
 *     scanned for `decision` and refuses the row — the advice in the doc is only half true, and the
 *     test is where the other half is written down.
 */
import { describe, expect, it } from 'vitest'

import { parseArgs, rehearseRecords, renderReport } from '../scripts/rewrite-rehearsal.ts'

/** One dump row with the columns `normalizeItem()` reads; the rest default. */
function record(id: string, cells: { nextStep: string; userNote?: string; actionType?: string }): Record<string, unknown> {
  return {
    id,
    title: id,
    description: '',
    nextStep: cells.nextStep,
    priority: 'P1',
    intervalMin: 1440,
    repoPath: 'D:\\gitAll\\demo',
    authorization: '自主',
    collaboration: 'sparse',
    approval: '已通过',
    userNote: cells.userNote ?? '',
    contribution: '功能增强',
    actionType: cells.actionType,
  }
}

/**
 * The three C-class rows, shortened to the cells that decide the reading.
 *
 * The ids are the real ones because the script's candidates are keyed by them; the prose is the real
 * shape of each row, not the whole cell.
 */
const ROWS: Record<string, unknown>[] = [
  record('recvuOzY5dp9MR', {
    nextStep: '扫 11-03 白天窗口出候选；若 A/B/C 仍未批复，则把 R75 遗留 4 条事实升级为 1 篇 note + MEMORY 行（ActiveMQ 凭证优先）',
    userNote: '2026-10-31 待批三问（审计见 相关文档）。',
    actionType: 'secret',
  }),
  record('reczz28QOfrbeaIn', {
    nextStep: '一、上线首轮盯 [preflight] 日志；二、定「阻断时是否仍落报告」口径；三、继续找静默降级缺口：写回失败吞异常。',
    userNote: '2026-10-26 执行器 codex->mcode。',
    actionType: 'release',
  }),
  record('reczz28SSxObE9Ec', {
    nextStep: '1) 现场导 pod 日志确认回调行；2) 继续补自检：applyTokenSite 仍无单测；3) 待用户拍板的跨仓动作。',
    actionType: 'secret',
  }),
]

describe('rewrite rehearsal', () => {
  const rows = rehearseRecords(ROWS)

  it('reads all three C-class rows and holds the control for every one', () => {
    expect(rows.map((row) => row.id)).toEqual(['recvuOzY5dp9MR', 'reczz28QOfrbeaIn', 'reczz28SSxObE9Ec'])
    expect(rows.every((row) => row.controlRefused)).toBe(true)
    expect(rows.every((row) => row.control.kind !== 'repo-code' && row.control.kind !== 'repo-test' && row.control.kind !== 'repo-doc')).toBe(true)
  })

  it('flips only the row whose waiting half is a fact about the environment', () => {
    const row = rows.find((entry) => entry.id === 'reczz28QOfrbeaIn')
    expect(row?.proseNow.kind).toBe('release')
    expect(row?.after.kind).toBe('repo-code')
    expect(row?.proseFlipped).toBe(true)
    // The written cell still wins: rewriting the prose does not move the row until the cell moves too.
    expect(row?.afterWithCell.kind).toBe('release')
    expect(row?.rowWouldBeRepoWork).toBe(false)
  })

  it('does not flip a row whose waiting half is a pending decision, in either cell', () => {
    const third = rows.find((entry) => entry.id === 'reczz28SSxObE9Ec')
    expect(third?.after.kind).toBe('decision')
    expect(third?.proseFlipped).toBe(false)
    // Moving 拍板 into 用户批注 refuses the row: that field is read for pending decisions.
    expect(third?.after.matched).toContain('拍板')
  })

  it('names a past note as the blocker when the history alone refuses a clean rewrite', () => {
    const first = rows.find((entry) => entry.id === 'recvuOzY5dp9MR')
    expect(first?.after.kind).toBe('decision')
    expect(first?.afterCleanNote.kind).toBe('repo-doc')
  })

  it('reports the tally instead of pretending the rehearsal passed', () => {
    const report = renderReport('fixture.ndjson', rows)
    expect(report).toContain('prose flips 1/3')
    expect(report).toContain('rows that would be repo work 0/3')
    expect(report).toContain('RESULT: MEASURED')
    expect(report).toContain('recvuOzY5dp9MR')
  })

  it('fails loudly when a candidate row is not in the dump', () => {
    expect(() => rehearseRecords([ROWS[0] as Record<string, unknown>])).toThrow(/reczz28QOfrbeaIn/)
  })

  it('parses only the flags it documents', () => {
    expect(parseArgs(['--dump', 'x.ndjson', '--json'])).toEqual({ dump: 'x.ndjson', json: true, help: false })
    expect(() => parseArgs(['--dump'])).toThrow(/--dump/)
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/)
  })
})
