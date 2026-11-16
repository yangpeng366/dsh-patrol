#!/usr/bin/env node
/**
 * repo-cell-audit — which `仓库路径` cells are not a single, proven local directory?
 *
 * The direction table's repo column is free text. Three shapes coexist in it: a bare path, a path
 * with a note glued on (`E:\gitAll\openeyes（门禁…）`), and a cell that names more than one repo
 * (`D:\gitAll\mpd + D:\gitAll\mpd-front`, or four sources separated by `;`). Only the first shape
 * is what a repo allowlist can be matched against without guessing, which is why the row-based
 * directions keep asking for a "纯路径" column: the answer exists, but reading it by eye rots.
 *
 * This script derives that answer from any direction-table dump with the Gate's own module
 * (`src/core/repo-facts.ts`) and the real filesystem, so "which cell still writes two repos" is a
 * re-runnable command instead of a reading. It is read-only: it never writes the table, never
 * probes anything but `statSync`, and never dispatches.
 *
 * It separates three states, because "clean" has two kinds of dirty:
 *   - `pure`      the cell text *is* the path, exactly (`D:\gitAll\mpd`)
 *   - `normalized` one proven directory, but the text needs tidying (trailing slash, `d:` case is
 *                  fine — only `/`, `\` and drive case are folded, never prose)
 *   - `offender`  no single proven directory: empty, two repos, prose, file, missing, uncloned
 *
 *   node scripts/repo-cell-audit.mjs                       # newest dump under .artifacts/direction
 *   node scripts/repo-cell-audit.mjs --file <dump.ndjson>
 *   node scripts/repo-cell-audit.mjs --file <dump.ndjson> --json
 *   node scripts/repo-cell-audit.mjs --file <dump.ndjson> --strict   # exit 1 if any offender
 *
 * Exit codes: 0 the audit ran (and, with `--strict`, every cell is a single proven directory),
 * 1 `--strict` found at least one offender, 2 usage or unreadable input.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_DIR = '.artifacts/direction'

/** Load the Gate's module the same way the other scripts do: real import, with a named failure. */
async function loadRepoFacts() {
  return import(new URL('../src/core/repo-facts.ts', import.meta.url).href).catch((error) => {
    throw new Error(`cannot load src/core/repo-facts.ts (needs Node >= 22.19 type stripping): ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * A Bitable cell as text.
 *
 * Same reading as the provider: an array is joined without a separator (the dump already carries
 * one segment per array entry), a null/blank cell is `''`, and a null entry inside an array is
 * nothing rather than the text `null` — the table writes `[null, 'D:\\x']` for an edited cell. The
 * *raw* value is what `inspectRepoPath()` gets, so this text is only for reporting.
 */
export function cellText(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== null && entry !== undefined)
      .map((entry) => (entry && typeof entry === 'object' ? JSON.stringify(entry) : String(entry)))
      .join('')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value).trim()
}

/** Newest `*.ndjson` in `dir`, or `undefined` when there is none. */
export function newestDump(dir = DEFAULT_DIR) {
  let names
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.ndjson'))
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined
  names.sort()
  return join(dir, names[names.length - 1])
}

/** Dump lines as objects, BOM and blank lines tolerated. */
export function parseDump(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Classify every row's `仓库路径` cell.
 *
 * `probe` is forwarded to `inspectRepoPath()`, so a test can decide what exists without a tree.
 * The row shape is the dump's own: `record_id`, `项目名`, `仓库路径`.
 */
export function auditCells(rows, options = {}) {
  const inspect = options.inspect
  if (typeof inspect !== 'function') throw new Error('auditCells needs the Gate\'s inspectRepoPath()')

  const tally = new Map()
  const offenders = []
  let pure = 0
  let normalized = 0

  for (const row of rows) {
    const raw = cellText(row['仓库路径'])
    const fact = inspect(row['仓库路径'], options.probe ? { probe: options.probe } : {})
    tally.set(fact.reason, (tally.get(fact.reason) ?? 0) + 1)

    if (fact.reason === 'repo-exists-ok') {
      // `pure` is byte-equal text, not case-insensitively equal: `d:\gitAll\x\` and `D:/gitAll/x`
      // name the same directory but are not what a 纯路径 column would hold, and folding them
      // here would report a cell as clean exactly where a human still has to edit it.
      if (raw === fact.normalizedPath) pure += 1
      else normalized += 1
      continue
    }

    offenders.push({
      recordId: row.record_id ?? '',
      name: cellText(row['项目名']),
      raw,
      reason: fact.reason,
      kind: fact.kind,
      candidates: fact.candidates ?? [],
    })
  }

  return {
    total: rows.length,
    pure,
    normalized,
    offenders,
    tally: [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
  }
}

/** The human report, one line per fact that needs to be read. */
export function renderReport(report, source) {
  const lines = []
  lines.push(`source: ${source}`)
  lines.push(`rows=${report.total}  pure=${report.pure}  normalized=${report.normalized}  offenders=${report.offenders.length}`)
  for (const { reason, count } of report.tally) {
    lines.push(`  ${String(count).padStart(3)}  ${reason}`)
  }
  if (report.offenders.length === 0) {
    lines.push('every 仓库路径 cell is a single proven local directory')
    return lines.join('\n')
  }
  lines.push('--- cells that are not a single proven directory ---')
  for (const row of report.offenders) {
    lines.push(`${row.recordId} | ${row.name} | ${row.reason} | ${JSON.stringify(row.raw)}`)
    for (const candidate of row.candidates) {
      const note = candidate.annotation ? ` // ${candidate.annotation}` : ''
      lines.push(`    ${JSON.stringify(candidate.path)} ${candidate.kind}${note}`)
    }
  }
  return lines.join('\n')
}

/** `--strict` makes "no offenders" a gate instead of a report. */
export function exitCodeFor(report, strict) {
  if (!strict) return 0
  return report.offenders.length === 0 ? 0 : 1
}

/** Flag parsing, kept separate so a test can assert the defaults without touching disk. */
export function parseArgs(argv) {
  const options = { file: undefined, json: false, strict: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--file') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--file needs a path')
      options.file = value
      index += 1
    } else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`repo-cell-audit: ${error.message}`)
    console.error('usage: node scripts/repo-cell-audit.mjs [--file <dump.ndjson>] [--json] [--strict]')
    return 2
  }
  if (options.help) {
    console.log('usage: node scripts/repo-cell-audit.mjs [--file <dump.ndjson>] [--json] [--strict]')
    console.log('  --file    direction-table ndjson dump (default: newest under .artifacts/direction)')
    console.log('  --json    print the report as one JSON object')
    console.log('  --strict  exit 1 when any cell is not a single proven directory')
    return 0
  }

  const source = options.file ? resolve(options.file) : newestDump()
  if (!source) {
    console.error('repo-cell-audit: no ndjson dump found; pass --file <dump.ndjson>')
    return 2
  }

  let rows
  try {
    rows = parseDump(readFileSync(source, 'utf8'))
  } catch (error) {
    console.error(`repo-cell-audit: cannot read ${source}: ${error.message}`)
    return 2
  }

  const repoFacts = await loadRepoFacts()
  const report = auditCells(rows, { inspect: repoFacts.inspectRepoPath })

  if (options.json) console.log(JSON.stringify({ source, ...report }, null, 2))
  else console.log(renderReport(report, source))
  return exitCodeFor(report, options.strict)
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
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
