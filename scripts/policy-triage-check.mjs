#!/usr/bin/env node
/**
 * policy-triage-check — does `docs/policy-v4-triage.md` still describe the log it claims to?
 *
 * The triage classifies 68 would-accept rows one by one. Prose that is checked by eye rots: a row
 * gets re-judged, a count is edited in one place and not the other, a verdict is spelled three
 * ways. This script re-derives the same facts from the two files the doc names — the decision log
 * and the direction-table dump — and refuses to pass when they disagree with the doc.
 *
 * It checks four things and nothing else:
 *   1. coverage: every would-accept record in the log has exactly one row in the doc's table,
 *      and the doc's table names no record the log did not judge;
 *   2. vocabulary: a verdict is one of auto / approval / read-only / excluded;
 *   3. structure: the verdict agrees with the structured facts the doc's own 口径 (policy-v4-triage
 *      §2) names — 巡检间隔 0/空 or an empty 下一步 is `excluded`, 授权边界=只读 is `read-only` or
 *      `excluded`, 需审批 is `approval` or `excluded`, and `auto` needs a running row, 自主, and a
 *      local repo cell. These are the only rules a script may apply: the rest of the 口径 reads
 *      `下一步` prose and is a human judgement recorded in the doc;
 *   4. numbers: the `triage-summary` block equals the counts derived here, including the v4 replay
 *      of both logs (what the new `schedule-stopped` layer would change).
 *
 *   node scripts/policy-triage-check.mjs
 *   node scripts/policy-triage-check.mjs --doc docs/policy-v4-triage.md \
 *     --file .artifacts/patrol-decisions-20261110.jsonl \
 *     --replay-file .artifacts/patrol-decisions-20261110-v2.jsonl \
 *     --table .artifacts/direction/tbl2XGd8bO10NBY5_20261111_060500_289.ndjson
 *
 * Exit codes: 0 pass, 1 a check failed, 2 usage or unreadable input. It reads files only.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERDICTS = ['auto', 'approval', 'read-only', 'excluded']

const USAGE = `usage: node scripts/policy-triage-check.mjs [options]

  --doc <path>          triage document (default docs/policy-v4-triage.md)
  --file <path>         decision log the doc classifies (default .artifacts/patrol-decisions-20261110.jsonl)
  --replay-file <path>  second log for the v4 replay (default .artifacts/patrol-decisions-20261110-v2.jsonl)
  --table <path>        direction-table ndjson dump (default: none — structural checks are skipped)
  --json                print the report as one JSON object
  --help, -h            show this message

Exit codes: 0 pass, 1 a check failed, 2 usage or unreadable input.`

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Cells of a markdown table line, or null when the line is not a table row. */
function cells(line) {
  if (!line.startsWith('|')) return null
  return line.split('|').map((cell) => cell.trim())
}

/**
 * The doc's per-row table: `| n | \`rec…\` | … | **verdict** | … |`.
 *
 * Record ids are read from the backticked cell and verdicts from the bolded cell, so a column
 * reorder in the prose does not silently change what is counted.
 */
export function parseTriageRows(markdown) {
  const rows = []
  for (const line of markdown.split(/\r?\n/)) {
    const parts = cells(line)
    if (!parts || parts.length < 4) continue
    const idCell = parts.find((cell) => /^`rec[A-Za-z0-9]+`$/.test(cell))
    const verdictCell = parts.find((cell) => /^\*\*(auto|approval|read-only|excluded)\*\*$/.test(cell))
    if (!idCell || !verdictCell) continue
    rows.push({ recordId: idCell.slice(1, -1), verdict: verdictCell.slice(2, -2) })
  }
  return rows
}

/** The `triage-summary` fenced block: one `key=number` per line, blank lines and # ignored. */
export function parseSummaryBlock(markdown) {
  const match = /```triage-summary\r?\n([\s\S]*?)```/.exec(markdown)
  if (!match) return null
  const summary = {}
  for (const line of match[1].split(/\r?\n/)) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq < 0) continue
    summary[text.slice(0, eq).trim()] = Number(text.slice(eq + 1).trim())
  }
  return summary
}

/** `[recordId, Scope]` would-accept rows of a JSONL decision log, in file order. */
export function wouldAcceptRows(text) {
  const rows = []
  const bad = []
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      bad.push({ line: index + 1, error: messageOf(error) })
      return
    }
    if (!record?.wouldAccept) return
    const matched = /^trg_(rec[A-Za-z0-9]+)_/.exec(String(record.triggerId ?? ''))
    if (!matched) {
      bad.push({ line: index + 1, error: `cannot read a record id from triggerId ${String(record.triggerId ?? '(none)')}` })
      return
    }
    rows.push({ recordId: matched[1], scope: String(record.wouldAccept.scope ?? '') })
  })
  return { rows, bad }
}

/** Direction-table dump rows, keyed by `record_id`. */
export function tableFacts(text) {
  const rows = new Map()
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = JSON.parse(line)
    if (typeof row.record_id !== 'string' || row.record_id === '') continue
    rows.set(row.record_id, {
      title: cell(row['项目名']),
      intervalMin: cell(row['巡检间隔(分钟)']),
      authorization: cell(row['授权边界']),
      approval: cell(row['审批状态']),
      nextStep: cell(row['下一步']),
      repoPath: cell(row['仓库路径']),
    })
  }
  return rows
}

/** A Bitable cell: arrays join, empties become ''. */
function cell(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((entry) => (entry && typeof entry === 'object' ? JSON.stringify(entry) : String(entry))).join('')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).trim()
}

/** The structured verdict the doc's §2 口径 forces, or null when prose decides. */
export function structuredVerdict(facts) {
  const interval = Number(facts.intervalMin === '' ? 0 : facts.intervalMin)
  if (!(interval > 0)) return 'excluded'
  if (facts.nextStep === '') return 'excluded'
  if (facts.authorization === '只读') return 'read-only'
  if (facts.authorization === '需审批') return 'approval'
  return null
}

/** What Policy v4 would decide for one row, mirroring the Gate's order. */
function replayVerdict(facts) {
  const interval = Number(facts.intervalMin === '' ? 0 : facts.intervalMin)
  if (!(interval > 0)) return 'schedule-stopped'
  if (facts.approval === '已忽略' || facts.approval === '阻塞' || facts.approval === '待审') return `approval-${facts.approval}`
  if (facts.authorization === '只读') return 'read-only-direction'
  if (facts.authorization === '需审批') return 'needs-approval'
  if (facts.nextStep === '') return 'no-next-step'
  if (facts.repoPath === '') return 'no-repo-path'
  return 'would-accept'
}

/**
 * Runs every check.
 *
 * @returns {{ok:boolean, checks:{name:string, ok:boolean, detail:string}[], counts:object, summary:object|null}}
 */
export function auditTriage({ markdown, decisionsText, replayText, tableText, hasTable }) {
  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })

  const docRows = parseTriageRows(markdown)
  const summaryBlock = parseSummaryBlock(markdown)
  const decisions = wouldAcceptRows(decisionsText)

  // 1 — coverage, both directions.
  const byId = new Map()
  for (const row of docRows) {
    if (!byId.has(row.recordId)) byId.set(row.recordId, [])
    byId.get(row.recordId).push(row)
  }
  const duplicated = [...byId.entries()].filter(([, entries]) => entries.length > 1).map(([id]) => id)
  const logged = new Set(decisions.rows.map((row) => row.recordId))
  const missing = [...logged].filter((id) => !byId.has(id))
  const unknown = [...byId.keys()].filter((id) => !logged.has(id))
  record(
    'table:coverage',
    missing.length === 0 && unknown.length === 0 && duplicated.length === 0 && decisions.bad.length === 0,
    [
      `${docRows.length} rows for ${decisions.rows.length} would-accept records`,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unknown.length > 0 ? `not in the log: ${unknown.join(', ')}` : '',
      duplicated.length > 0 ? `listed twice: ${duplicated.join(', ')}` : '',
      decisions.bad.length > 0 ? `unreadable log lines: ${decisions.bad.map((bad) => bad.line).join(', ')}` : '',
    ].filter(Boolean).join(' · '),
  )

  // 2 — vocabulary.
  const odd = docRows.filter((row) => !VERDICTS.includes(row.verdict)).map((row) => `${row.recordId}=${row.verdict}`)
  record('table:verdicts', odd.length === 0, odd.length === 0 ? VERDICTS.join(' / ') : `unexpected: ${odd.join(', ')}`)

  const counts = { auto: 0, approval: 0, 'read-only': 0, excluded: 0 }
  for (const row of docRows) counts[row.verdict] += 1
  const derived = { total: docRows.length, ...counts }

  // 3 — the structured part of the 口径, and the replay, need the table dump. The counts above do not.
  if (hasTable) {
    const facts = tableFacts(tableText)
    const mismatches = []
    for (const row of docRows) {
      const rowFacts = facts.get(row.recordId)
      if (!rowFacts) {
        mismatches.push(`${row.recordId}: no row in the table dump`)
        continue
      }
      const forced = structuredVerdict(rowFacts)
      if (forced && forced !== row.verdict) mismatches.push(`${row.recordId}: 口径 forces ${forced}, doc says ${row.verdict}`)
      if (row.verdict === 'auto') {
        if (!(Number(rowFacts.intervalMin) > 0)) mismatches.push(`${row.recordId}: auto on a stopped row`)
        if (rowFacts.authorization !== '自主') mismatches.push(`${row.recordId}: auto with 授权边界=${rowFacts.authorization || '(空)'}`)
        if (rowFacts.repoPath === '' || rowFacts.repoPath.startsWith('（未克隆）') || rowFacts.repoPath.startsWith('(未克隆)')) {
          mismatches.push(`${row.recordId}: auto without a local repo cell`)
        }
      }
    }
    record('table:structure', mismatches.length === 0, mismatches.length === 0 ? 'every structured row agrees with §2' : mismatches.join(' · '))

    const replay = (text) => {
      const result = { scheduleStopped: 0, wouldAccept: 0 }
      for (const row of wouldAcceptRows(text).rows) {
        const rowFacts = facts.get(row.recordId)
        if (!rowFacts) continue
        if (replayVerdict(rowFacts) === 'schedule-stopped') result.scheduleStopped += 1
        else if (replayVerdict(rowFacts) === 'would-accept') result.wouldAccept += 1
      }
      return result
    }
    const replayMain = replay(decisionsText)
    const replaySecond = replayText === null ? null : replay(replayText)
    derived['replay-v1-schedule-stopped'] = replayMain.scheduleStopped
    derived['replay-v1-would-accept'] = replayMain.wouldAccept
    if (replaySecond) {
      derived['replay-v2-schedule-stopped'] = replaySecond.scheduleStopped
      derived['replay-v2-would-accept'] = replaySecond.wouldAccept
    }
  } else {
    record('table:structure', true, 'skipped: no --table dump, so only coverage, vocabulary and the counts were checked')
  }

  // 4 — the published numbers, compared key by key against what the doc's own rows say.
  const expected = summaryBlock ?? {}
  const wrong = Object.entries(derived)
    .filter(([key, value]) => expected[key] !== value)
    .map(([key, value]) => `${key}: doc ${expected[key] ?? '(absent)'}, derived ${value}`)
  const extra = Object.keys(expected).filter((key) => !(key in derived) && !(!hasTable && key.startsWith('replay-')))
  const unchecked = Object.keys(expected).filter((key) => !(key in derived) && !hasTable && key.startsWith('replay-'))
  record(
    'summary:counts',
    summaryBlock !== null && wrong.length === 0 && extra.length === 0,
    summaryBlock === null
      ? 'no ```triage-summary block'
      : [wrong.join(' · '), extra.length > 0 ? `unexpected keys: ${extra.join(', ')}` : '', unchecked.length > 0 ? `not checked without --table: ${unchecked.join(', ')}` : ''].filter(Boolean).join(' · ')
        || `total ${derived.total} · auto ${counts.auto} · approval ${counts.approval} · read-only ${counts['read-only']} · excluded ${counts.excluded}`,
  )

  return { ok: checks.every((check) => check.ok), checks, counts: derived, summary: summaryBlock }
}

function readOrNull(path) {
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readRequired(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${messageOf(error)}`)
  }
}

function parseArgs(argv) {
  const options = {
    doc: 'docs/policy-v4-triage.md',
    file: '.artifacts/patrol-decisions-20261110.jsonl',
    replayFile: '.artifacts/patrol-decisions-20261110-v2.jsonl',
    table: '',
    json: false,
    help: false,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (['--doc', '--file', '--replay-file', '--table'].includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a path`)
      if (arg === '--doc') options.doc = value
      else if (arg === '--file') options.file = value
      else if (arg === '--replay-file') options.replayFile = value
      else options.table = value
      index += 1
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else positional.push(arg)
  }
  if (positional.length > 0) throw new Error(`unexpected argument ${positional[0]}`)
  return options
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`policy-triage-check: ${messageOf(error)}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  let markdown
  let decisionsText
  try {
    markdown = readRequired(resolve(process.cwd(), options.doc))
    decisionsText = readRequired(resolve(process.cwd(), options.file))
  } catch (error) {
    process.stderr.write(`policy-triage-check: ${messageOf(error)}\n`)
    return 2
  }
  const replayText = readOrNull(resolve(process.cwd(), options.replayFile))
  const tableText = readOrNull(resolve(process.cwd(), options.table))

  const report = auditTriage({
    markdown,
    decisionsText,
    replayText,
    tableText: tableText ?? '',
    hasTable: tableText !== null,
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ doc: options.doc, ...report }, null, 2)}\n`)
  } else {
    const lines = [`triage: ${options.doc}`]
    for (const check of report.checks) lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
    if (tableText === null && options.table === '') lines.push('  note: pass --table <dump.ndjson> to re-check the structured verdicts')
    lines.push('', report.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return report.ok ? 0 : 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entry && entry === import.meta.url) process.exitCode = main(process.argv.slice(2))
