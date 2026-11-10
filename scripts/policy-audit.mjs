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
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Verdict order used for the summary, so two runs on the same file print the same thing. */
const VERDICT_ORDER = ['admitted', 'observed', 'ignored', 'unavailable']

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function preview(raw) {
  const text = raw.trim()
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/**
 * Summarises JSONL text.
 *
 * @param {string} text - File contents, with or without a leading UTF-8 BOM.
 * @returns {{total:number, blankLines:number, badLines:{line:number,error:string,text:string}[], verdicts:Record<string,number>, reasons:Record<string,number>, wouldAccept:object[]}}
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

  for (const { line, record } of records) {
    verdicts[record.verdict] = (verdicts[record.verdict] ?? 0) + 1
    const reason = typeof record.reason === 'string' && record.reason !== '' ? record.reason : '(none)'
    reasons[reason] = (reasons[reason] ?? 0) + 1
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

  return { total: records.length, blankLines, badLines, verdicts, reasons, wouldAccept }
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
