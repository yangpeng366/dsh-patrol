#!/usr/bin/env node
/**
 * policy-audit — read the decision log written by `decisionLogPath` and summarise it.
 *
 * The question this answers is the one `observe` mode raises: *which rows would have been
 * accepted, and why was every other row refused?* It reads the JSONL file only; it never talks
 * to the source, the Engine or the network.
 *
 *   node scripts/policy-audit.mjs --file .artifacts/decisions.jsonl
 *   node scripts/policy-audit.mjs --file .artifacts/decisions.jsonl --json
 *
 * A damaged line is reported with its line number and skipped; it never aborts the audit.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Verdict order used for the summary, so two runs on the same file print the same thing. */
const VERDICT_ORDER = ['admitted', 'observed', 'stopped', 'ignored', 'unavailable']

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function preview(raw) {
  const text = raw.trim()
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

const STOPPED_EVENTS = new Set(['snapshot', 'added', 'removed', 'heartbeat'])

function stoppedEventOf(record) {
  return typeof record.stoppedEvent === 'string' && STOPPED_EVENTS.has(record.stoppedEvent) ? record.stoppedEvent : null
}

/** New lines carry `recordId`; legacy rows and synthetic rows fall back to the thread key. */
function stoppedRowKey(record) {
  if (typeof record.recordId === 'string' && record.recordId !== '') return record.recordId
  if (typeof record.threadKey === 'string' && record.threadKey !== '') return record.threadKey
  return null
}

function stoppedFingerprintOf(rows) {
  const material = [...rows.entries()]
    .map(([key, entry]) => `${key}\u0000${entry.intervalMin ?? ''}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('\n')
  return createHash('sha256').update(material).digest('hex')
}

/**
 * Summarises JSONL text.
 *
 * @param {string} text - File contents, with or without a leading UTF-8 BOM.
 * @returns {{total:number, blankLines:number, badLines:{line:number,error:string,text:string}[], verdicts:Record<string,number>, reasons:Record<string,number>, wouldAccept:object[], stopped:object[], stoppedState:object}}
 */
export function auditText(text) {
  // A BOM is what a Windows editor adds; strip it instead of reporting line 1 as corrupt.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const records = []
  const badLines = []
  let blankLines = 0

  lines.forEach((raw, index) => {
    const line = index + 1
    if (raw.trim() === '') { blankLines += 1; return }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      badLines.push({ line, error: `invalid JSON: ${messageOf(error)}`, text: preview(raw) })
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines.push({ line, error: 'not a JSON object', text: preview(raw) })
      return
    }
    if (typeof parsed.verdict !== 'string' || parsed.verdict === '') {
      badLines.push({ line, error: 'missing string field `verdict`', text: preview(raw) })
      return
    }
    records.push({ line, record: parsed })
  })

  const verdicts = {}
  for (const verdict of VERDICT_ORDER) verdicts[verdict] = 0
  const reasons = {}
  const wouldAccept = []
  // Replay the stopped-set state machine, not every historical line: `snapshot` resets the set,
  // `added` / `removed` apply one row, and `heartbeat` proves the unchanged set is still fresh.
  // Lines written before `stoppedEvent` existed are replayed per round, so the latest round wins.
  const stoppedRows = new Map()
  let stoppedSnapshotRound = null
  let legacyStoppedRound = null
  let lastStoppedEvent = null
  let lastStoppedLine = null
  let lastStoppedHeartbeat = null

  for (const { line, record } of records) {
    verdicts[record.verdict] = (verdicts[record.verdict] ?? 0) + 1
    const reason = typeof record.reason === 'string' && record.reason !== '' ? record.reason : '(none)'
    reasons[reason] = (reasons[reason] ?? 0) + 1
    if (record.verdict === 'stopped') {
      const event = stoppedEventOf(record)
      const key = stoppedRowKey(record)
      const entry = {
        line,
        ts: record.ts ?? null,
        roundId: record.roundId ?? null,
        threadKey: record.threadKey ?? null,
        recordId: record.recordId ?? null,
        intervalMin: typeof record.intervalMin === 'number' ? record.intervalMin : null,
        stoppedSince: typeof record.stoppedSince === 'string' ? record.stoppedSince : null,
        reason,
        event,
      }
      if (event === 'snapshot') {
        if (stoppedSnapshotRound !== (record.roundId ?? null)) {
          stoppedRows.clear()
          stoppedSnapshotRound = record.roundId ?? null
        }
        if (key) stoppedRows.set(key, entry)
      } else if (event === 'removed') {
        if (key) stoppedRows.delete(key)
      } else if (event === 'added') {
        if (key) stoppedRows.set(key, entry)
      } else if (event === null && key) {
        // Legacy logs had no event marker and wrote the whole set every round. Keep the latest
        // round as the current set instead of unioning every historical stopped row.
        const legacyRound = record.roundId ?? null
        if (legacyStoppedRound !== null && legacyRound !== null && legacyRound !== legacyStoppedRound) {
          stoppedRows.clear()
        }
        legacyStoppedRound = legacyRound
        stoppedRows.set(key, entry)
      }
      if (event !== null) legacyStoppedRound = null
      lastStoppedEvent = event ?? 'legacy'
      lastStoppedLine = line
      if (event === 'heartbeat') lastStoppedHeartbeat = { line, ts: entry.ts, roundId: entry.roundId, count: record.stoppedCount ?? null, fingerprint: record.stoppedFingerprint ?? null }
    }
    // `wouldAccept` is the object the Engine puts on a held-back accept. A bare `true` is
    // tolerated so a hand-written line still shows up in the list.
    const held = record.wouldAccept
    if (held && held !== true && typeof held === 'object') {
      wouldAccept.push({
        line,
        ts: record.ts ?? null,
        roundId: record.roundId ?? null,
        threadKey: record.threadKey ?? null,
        verdict: record.verdict,
        reason,
        title: held.title ?? null,
        scope: held.scope ?? null,
        rules: Array.isArray(held.rules) ? held.rules : [],
      })
    } else if (held === true) {
      wouldAccept.push({
        line,
        ts: record.ts ?? null,
        roundId: record.roundId ?? null,
        threadKey: record.threadKey ?? null,
        verdict: record.verdict,
        reason,
        title: null,
        scope: null,
        rules: [],
      })
    }
  }

  const stopped = [...stoppedRows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => ({ key, ...entry }))
  const stoppedState = {
    count: stopped.length,
    fingerprint: stoppedFingerprintOf(stoppedRows),
    lastEvent: lastStoppedEvent,
    lastLine: lastStoppedLine,
    lastHeartbeat: lastStoppedHeartbeat,
  }
  return { total: records.length, blankLines, badLines, verdicts, reasons, wouldAccept, stopped, stoppedState }
}

function orderedReasons(reasons) {
  return Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function formatHuman(file, summary) {
  const out = []
  out.push(`decision log: ${file}`)
  out.push(`records: ${summary.total}${summary.badLines.length > 0 ? `  (bad lines: ${summary.badLines.length})` : ''}`)
  out.push('')
  out.push('by verdict:')
  for (const [verdict, count] of Object.entries(summary.verdicts)) out.push(`  ${verdict.padEnd(12)} ${count}`)
  out.push('')
  out.push('by reason:')
  if (Object.keys(summary.reasons).length === 0) out.push('  (none)')
  for (const [reason, count] of orderedReasons(summary.reasons)) out.push(`  ${String(count).padStart(5)}  ${reason}`)
  out.push('')
  out.push(`would-accept (held for review): ${summary.wouldAccept.length}`)
  for (const entry of summary.wouldAccept) {
    out.push(`  #${entry.line} ${entry.ts ?? '(no ts)'} ${entry.threadKey ?? '(no threadKey)'} verdict=${entry.verdict} reason=${entry.reason}`)
    out.push(`      title: ${entry.title ?? '(none)'}`)
    out.push(`      scope: ${entry.scope ?? '(none)'}`)
    if (entry.rules.length > 0) out.push(`      rules: ${entry.rules.join(', ')}`)
  }
  out.push('')
  out.push(`stopped rows (recorded, not dispatched): ${summary.stopped.length}`)
  for (const entry of summary.stopped) {
    out.push(`  #${entry.line} ${entry.ts ?? '(no ts)'} ${entry.recordId ?? '(no recordId)'} 巡检间隔=${entry.intervalMin === null ? '(absent)' : entry.intervalMin} 停跑自=${entry.stoppedSince ?? '(unknown)'} reason=${entry.reason}`)
  }
  out.push(`stopped set: count=${summary.stoppedState.count} fingerprint=${summary.stoppedState.fingerprint} lastEvent=${summary.stoppedState.lastEvent ?? '(none)'}`)
  if (summary.badLines.length > 0) {
    out.push('')
    out.push('bad lines (skipped, audit continued):')
    for (const bad of summary.badLines) out.push(`  line ${bad.line}: ${bad.error} — ${bad.text}`)
  }
  return `${out.join('\n')}\n`
}

const USAGE = `usage: node scripts/policy-audit.mjs --file <decisions.jsonl> [--json]

  --file, -f  JSONL written by the plugin (decisionLogPath). Relative to the current directory.
  --json      print the summary as one JSON object instead of text.
  --help, -h  show this message.
`

function parseArgs(argv) {
  const options = { file: '', json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--file' || arg === '-f') {
      const value = argv[i + 1]
      if (!value) throw new Error(`${arg} needs a path`)
      options.file = value
      i += 1
    } else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else if (!options.file) options.file = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  return options
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`policy-audit: ${messageOf(error)}\n\n${USAGE}`)
    return 2
  }
  if (options.help) { process.stdout.write(USAGE); return 0 }
  if (!options.file) { process.stderr.write(`policy-audit: --file is required\n\n${USAGE}`); return 2 }

  const file = resolve(process.cwd(), options.file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    process.stderr.write(`policy-audit: cannot read ${file}: ${messageOf(error)}\n`)
    return 1
  }

  const summary = auditText(text)
  if (options.json) process.stdout.write(`${JSON.stringify({ file, ...summary }, null, 2)}\n`)
  else process.stdout.write(formatHuman(file, summary))
  return 0
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entry && entry === import.meta.url) process.exitCode = main(process.argv.slice(2))
