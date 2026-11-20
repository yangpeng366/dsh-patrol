#!/usr/bin/env node
/**
 * rewrite-rehearsal — can a refused row be *rewritten* into repo work, or only *relabelled*?
 *
 * `docs/local-json-round.md` ends with the advice "take the executable half of `下一步` as the row's
 * action line, move the half that waits for a human or a site into `用户批注`". That advice is a claim
 * about the word list, and until now it was a claim nobody had run: the C-class rows were named, not
 * rehearsed. This script runs the rehearsal against the real table dump, with the real classifier
 * (`inspectAction()`), and prints three readings per row:
 *
 *   1. `now`    — the row as the table has it (column first). What the Gate refuses today.
 *   2. `after`  — the rewritten `下一步` + the moved half appended to `用户批注`, column blanked so the
 *                 word list alone decides. This is the question the advice asks: does the prose read
 *                 as `repo-code` / `repo-test` / `repo-doc`?
 *   3. `control`— the rewritten `下一步` with the moved half put *back* into it. If the split is what
 *                 flipped the row, the control must go back to a refusal. If the control also reads
 *                 repo-*, the flip came from deleted words, not from moving half a sentence, and the
 *                 rewrite is a relabelling — this script then fails.
 *
 * A rewritten row is also read *with* its original `动作类型` cell, because a written cell wins over
 * prose (`inspectAction()`): the honest answer to "can the row be flipped" has to say whether the
 * prose changed, separately from whether the cell would still overrule it.
 *
 *   node scripts/rewrite-rehearsal.ts                    # newest dump under .artifacts/direction
 *   node scripts/rewrite-rehearsal.ts --dump <path>      # explicit dump
 *   node scripts/rewrite-rehearsal.ts --json             # machine-readable
 *
 * No table is written, no Ticket is opened, no file is touched.
 *
 * Exit codes: 0 the measurement is valid — every candidate was found and every control went back to
 * a refusal; 1 the measurement is not trustworthy (a control stayed repo-*, so a "flip" may just be
 * deleted words); 2 usage or unreadable input. A valid measurement that says "only one row flips"
 * exits 0: a tool that fails because reality says no is not a measurement.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { newestDump } from './repo-cell-audit.mjs'
import { recordsFromDump } from './local-json-round.ts'
import { inspectAction, isRepoWork, type ActionFacts } from '../src/core/action-facts.ts'
import { normalizeItem, type DirectionItem } from '../src/source/provider.ts'

/**
 * The rehearsal candidates: the three C-class rows of `docs/local-json-round.md`, each with the half
 * that waits on a person cut out and the half the row could do on its own kept.
 *
 * A candidate is data, not code: the rewrite is what a human would have to type into the table, so
 * it stays readable and reviewable here instead of being generated. `moved` is appended to the row's
 * existing `用户批注`, never replacing it — the table's history is not this script's to rewrite.
 */
interface Candidate {
  id: string
  title: string
  /** The rewritten `下一步` — only the executable half. */
  nextStep: string
  /** The half that waits for a person or a site, moved out of `下一步` into `用户批注`. */
  moved: string
  /**
   * The refusing wording as the row writes it *today*, verbatim. The control puts this back into
   * `下一步`: if the row still refuses with the original words in place, the split is what flips it.
   * Using `moved` here instead would let a rewrite that quietly reworded the refusal ("凭证" →
   * "连接信息") pass as a split.
   */
  waitingHalf: string
  /** Why this row is C-class: what makes it look rewritable in the first place. */
  why: string
}

const CANDIDATES: readonly Candidate[] = [
  {
    id: 'recvuOzY5dp9MR',
    title: 'session-memory-curator',
    why: '前半句是「扫 11-03 窗口出候选」的人工触发，后半句才是仓内可做的「写 note + MEMORY 行」；「凭证」一词把整行判成 secret',
    nextStep: '把 R75 遗留的 4 条事实整理成 1 篇笔记写进 vault，并在 MEMORY 里补一行索引',
    moved: '扫 11-03 白天窗口出候选由人工触发；A/B/C 批复前不改 curator 策略。ActiveMQ 连接信息只写位置与轮换方式，不写具体值（因此写笔记这一步本身落在仓内）。',
    waitingHalf: 'ActiveMQ 凭证优先',
  },
  {
    id: 'reczz28QOfrbeaIn',
    title: '巡检执行方式改造（三形态 + 双执行器）',
    why: '第一条（盯 [preflight] 日志）与第二条（定口径）要人，「继续找静默降级缺口」是仓内修复；「上线」把整行判成 release',
    nextStep: '在巡检脚本里修三处静默降级缺口：写回失败吞异常、缓存过期当现值用，并各补一条用例',
    moved: '上线首轮盯 [preflight] 日志（每轮约 7 秒、5 个短命 pwsh 子进程）与 -SkipFormPreflight 演练由人做；「阻断时是否仍落报告」的口径另行讨论。',
    waitingHalf: '上线首轮盯 [preflight] 日志',
  },
  {
    id: 'reczz28SSxObE9Ec',
    title: '多媒体-登出串号',
    why: '第 2 条（applyTokenSite 补单测）是仓内测试；第 1 条要现场导日志、第 3 条待人拍板，「token」「现场」「拍板」共同把整行判成 secret',
    nextStep: '把 applyTokenSite 的站点覆盖逻辑抽成纯函数，并补一条单测用例',
    moved: '现场导退出时刻的 articleeditor pod 日志确认「回调必留日志」；恢复 frame 门户退出时的批量子系统登出（SecurityLayout.jsx + models/login.js）仍在等人拍板；复测须等 ≥30～40 秒异步窗口。',
    waitingHalf: '现场导一次退出时刻的 articleeditor pod 全量日志',
  },
]

interface Reading {
  kind: string
  matched: string[]
  source: string
  reason: string
}

function read(input: Parameters<typeof inspectAction>[0]): ActionFacts {
  return inspectAction(input)
}

function summarize(facts: ActionFacts): Reading {
  return { kind: facts.kind, matched: facts.matched, source: facts.source, reason: facts.reason }
}

function inputFor(item: DirectionItem, nextStep: string, userNote: string, actionType: string | undefined) {
  return {
    actionType,
    nextStep,
    description: item.description,
    userNote,
    authorization: item.authorization,
    contribution: item.contribution,
    approval: item.approval,
  }
}

export interface RehearsalRow {
  id: string
  title: string
  why: string
  nextStep: string
  moved: string
  waitingHalf: string
  /** The row as the table has it: column first, prose fallback second. */
  now: Reading
  proseNow: Reading
  /** Rewritten prose, cell blanked — the question the advice asks. */
  after: Reading
  /**
   * The same rewrite with the row's *history* dropped from `用户批注` (only the moved half kept).
   * Printed when it differs from `after`: that difference names a past note as the blocker, i.e. a
   * row that cannot be flipped by rewriting `下一步` at all.
   */
  afterCleanNote: Reading
  /** Rewritten row with its original cell still in place — a written cell wins. */
  afterWithCell: Reading
  /** The moved half put back into `下一步`: must refuse, or the flip was a deletion. */
  control: Reading
  proseFlipped: boolean
  controlRefused: boolean
  rowWouldBeRepoWork: boolean
}

/** Runs the rehearsal over already-parsed rows (the shape `recordsFromDump()` returns). */
export function rehearseRecords(records: readonly Record<string, unknown>[]): RehearsalRow[] {
  const items = new Map(records.map((record) => normalizeItem(record)).map((item) => [item.id, item]))
  const rows: RehearsalRow[] = []
  for (const candidate of CANDIDATES) {
    const item = items.get(candidate.id)
    if (!item) throw new Error(`dump has no row ${candidate.id} (${candidate.title})`)
    const note = item.userNote === '' ? candidate.moved : `${item.userNote}\n${candidate.moved}`
    const now = read(inputFor(item, item.nextStep, item.userNote, item.actionType))
    const proseNow = read(inputFor(item, item.nextStep, item.userNote, ''))
    const after = read(inputFor(item, candidate.nextStep, note, ''))
    const afterCleanNote = read(inputFor(item, candidate.nextStep, candidate.moved, ''))
    const afterWithCell = read(inputFor(item, candidate.nextStep, note, item.actionType))
    const control = read(inputFor(item, `${candidate.nextStep}；${candidate.waitingHalf}`, note, ''))
    rows.push({
      id: candidate.id,
      title: candidate.title,
      why: candidate.why,
      nextStep: candidate.nextStep,
      moved: candidate.moved,
      waitingHalf: candidate.waitingHalf,
      now: summarize(now),
      proseNow: summarize(proseNow),
      after: summarize(after),
      afterCleanNote: summarize(afterCleanNote),
      afterWithCell: summarize(afterWithCell),
      control: summarize(control),
      proseFlipped: isRepoWork(after.kind),
      controlRefused: !isRepoWork(control.kind),
      rowWouldBeRepoWork: isRepoWork(afterWithCell.kind),
    })
  }
  return rows
}

/** Runs the rehearsal over one dump file. */
export function rehearse(dump: string): RehearsalRow[] {
  return rehearseRecords(recordsFromDump(readFileSync(dump, 'utf8')).records)
}

function show(reading: Reading): string {
  const terms = reading.matched.length > 0 ? ` [${reading.matched.join('+')}]` : ''
  return `${reading.kind}${terms}`
}

export function renderReport(dump: string, rows: readonly RehearsalRow[]): string {
  const lines: string[] = []
  lines.push('rewrite-rehearsal — C-class rows, rewritten 下一步 read through the action vocabulary')
  lines.push(`dump: ${dump}`)
  lines.push('')
  for (const row of rows) {
    lines.push(`${row.id}  ${row.title}`)
    lines.push(`  now     ${show(row.now)} (cell=${row.now.source}) · prose-only ${show(row.proseNow)}`)
    lines.push(`  after   prose ${show(row.after)} · with cell ${show(row.afterWithCell)} (${row.afterWithCell.source})`)
    if (row.afterCleanNote.kind !== row.after.kind) {
      lines.push(`  history ${show(row.afterCleanNote)} — the row's own 用户批注 is what still refuses it`)
    }
    lines.push(`  control ${show(row.control)}${row.controlRefused ? ' (refused, as it must be)' : ' (STILL repo-*: the flip was a deletion)'}`)
    lines.push(`  verdict prose flip ${row.proseFlipped ? 'yes' : 'no'} · row would be repo work ${row.rowWouldBeRepoWork ? 'yes' : 'no'}`)
  }
  const flipped = rows.filter((row) => row.proseFlipped).length
  const controlled = rows.filter((row) => row.controlRefused).length
  const admitted = rows.filter((row) => row.rowWouldBeRepoWork).length
  lines.push('')
  lines.push(`rows ${rows.length} · prose flips ${flipped}/${rows.length} · controls refused ${controlled}/${rows.length} · rows that would be repo work ${admitted}/${rows.length}`)
  const stuck = rows.filter((row) => row.proseFlipped && !row.rowWouldBeRepoWork)
  if (stuck.length > 0) {
    lines.push(`prose flips but the row is still refused: ${stuck.map((row) => `${row.id} (${row.afterWithCell.kind})`).join(', ')}`)
  }
  const valid = controlled === rows.length
  lines.push(`RESULT: ${valid ? 'MEASURED' : 'INVALID'} (the flip tally above is the answer; ${valid ? 'every control went back to a refusal' : 'a control stayed repo-*, so a flip may be deleted words'})`)
  return lines.join('\n')
}

const USAGE = `用法：
  node scripts/rewrite-rehearsal.ts [--dump <ndjson>] [--json]

  --dump <path>   direction-table dump; default: newest under .artifacts/direction
  --json          one JSON object instead of the report

只读：不写表、不开 Ticket、不改任何文件。退出码 0 = 测量有效（每个候选都找到、对照组都回到拒绝），
翻不翻得成看报告；1 = 对照组没回到拒绝，翻页结论不可信；2 = 参数或输入读不了。`

export function parseArgs(argv: string[]): { dump?: string; json: boolean; help: boolean } {
  const options: { dump?: string; json: boolean; help: boolean } = { json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dump') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--dump needs a path')
      options.dump = value
      i += 1
    } else throw new Error(`unknown argument ${arg}`)
  }
  return options
}

async function main(argv: string[]): Promise<number> {
  let options: { dump?: string; json: boolean; help: boolean }
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`rewrite-rehearsal: ${(error as Error).message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const dump = resolve(options.dump ?? newestDump() ?? '')
  let rows: RehearsalRow[]
  try {
    rows = rehearse(dump)
  } catch (error) {
    console.error(`rewrite-rehearsal: cannot rehearse ${dump || '(no dump found)'}: ${(error as Error).message}`)
    return 2
  }
  const valid = rows.every((row) => row.controlRefused)
  if (options.json) {
    console.log(JSON.stringify({ dump, rows, result: valid ? 'MEASURED' : 'INVALID', proseFlips: rows.filter((row) => row.proseFlipped).length, repoWorkRows: rows.filter((row) => row.rowWouldBeRepoWork).length }, null, 2))
    return valid ? 0 : 1
  }
  console.log(renderReport(dump, rows))
  return valid ? 0 : 1
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
