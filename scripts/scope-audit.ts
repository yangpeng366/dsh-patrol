#!/usr/bin/env node
/**
 * scope-audit — is the row's `仓库路径` the directory its `下一步` actually touches?
 *
 * `rewrite-rehearsal` ends on a fact no other script answers: a row can flip to `repo-code` in the
 * word list and still be dispatched at the wrong place. `reczz28QOfrbeaIn` says its work is the
 * patrol scripts (they live in `D:\_codex-control`) while its `仓库路径` names the Obsidian vault;
 * `reczz28SSxObE9Ec` names `SecurityLayout.jsx`, which is not in the repo its cell points at. The
 * action layer only answers "may an unattended round do this kind of work" — it never answers
 * "is this the repository that work belongs to".
 *
 * This script answers the second question with one bounded reading per row, taken from the row's own
 * cells:
 *
 *   - **roots** — every candidate in `仓库路径` that is a directory on disk (the Gate's own
 *     `inspectRepoPath()`, so a multi-repo or annotated cell contributes what it really resolves to);
 *   - **named** — absolute paths written in `下一步` that exist on disk. A path that does not exist
 *     proves nothing about scope (it is usually prose noise), so it is reported apart and never
 *     counted as drift;
 *   - **verdict** — `drift` when at least one named directory lies outside every root, `aligned`
 *     when all of them lie inside, `no-root` when the row names a directory but has no repo root to
 *     contain it, `silent` when it names no directory at all.
 *
 * `silent` is the honest name for "the row does not say where it acts": on this table it is the
 * majority, and it is why the drift count is a lower bound, not a total. A row whose cell is wrong
 * but whose prose never writes a path (`reczz28QOfrbeaIn`) lands there, and no amount of scanning
 * the cell can find it.
 *
 *   node scripts/scope-audit.ts                    # newest dump under .artifacts/direction
 *   node scripts/scope-audit.ts --dump <path>      # explicit dump
 *   node scripts/scope-audit.ts --due              # only rows the scheduler polls (interval > 0)
 *   node scripts/scope-audit.ts --json             # machine-readable
 *
 * Read-only: no table is written, no Ticket is opened, nothing on disk changes except the `statSync`
 * calls this reading is made of.
 *
 * Exit codes: 0 the audit ran (a drift count is an answer, not a failure); 2 usage or unreadable input.
 */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { inspectRepoPath } from '../src/core/repo-facts.ts'
import { normalizeItem } from '../src/source/provider.ts'
import { recordsFromDump } from './local-json-round.ts'
import { newestDump } from './repo-cell-audit.mjs'

/**
 * A path token as `下一步` writes it: a drive letter, a separator, then anything that is not a
 * separator-looking punctuation character.
 *
 * Deliberately greedy about Chinese and spaces-free tails; the `statSync` that follows is the filter
 * that matters, so a false positive here costs one failed look-up rather than a wrong count.
 */
const PATH_TOKEN = /(?<![A-Za-z0-9_])[A-Za-z]:(?:\\|\/)[^\s;；,，、。：:!！?？"'`<>|*（）()[\]{}]*/gu

/** A directory the row's `下一步` names, and what was found there. */
export interface NamedDir {
  /** The token as it appears in the cell, after the trailing punctuation was trimmed. */
  raw: string
  /** Absolute path the token denotes: the directory itself, or the parent of a named file. */
  path: string
  kind: 'directory' | 'parent-of-file'
}

/** One row's answer: where it claims to act, where it actually acts, and whether they agree. */
export interface ScopeReading {
  id: string
  title: string
  /** Candidates of `仓库路径` that exist as directories. */
  roots: string[]
  /** The Gate's own reason for the cell, e.g. `repo-exists-ok` / `repo-path-ambiguous`. */
  rootReason: string
  /** Directories named in `下一步` that exist on disk. */
  named: NamedDir[]
  /** Named directories outside every root; empty unless the verdict is `drift` / `no-root`. */
  outside: string[]
  /** Path tokens that are not on disk — prose noise or a typo, never counted as drift. */
  unreadable: string[]
  verdict: 'aligned' | 'drift' | 'no-root' | 'silent'
}

/** Whether `child` is `root` itself or lies below it. Case-folded: this is a Windows table. */
export function contains(root: string, child: string): boolean {
  const r = resolve(root).toLowerCase()
  const c = resolve(child).toLowerCase()
  if (c === r) return true
  const rel = relative(r, c)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Absolute path tokens in one cell, in reading order, deduplicated, punctuation trimmed. */
export function pathsIn(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_TOKEN)) {
    let raw = match[0]
    // A trailing sentence mark (`。`), a list separator, or a `:line` reference is not part of a path.
    raw = raw.replace(/[.。:：!！?？,，;；、]+$/u, '')
    raw = raw.replace(/:\d+(?::\d+)?$/u, '')
    raw = raw.replace(/[.。:：!！?？,，;；、]+$/u, '')
    if (raw.length < 4) continue
    seen.add(raw)
  }
  return [...seen]
}

/** One token → the directory it touches, when that directory exists. */
function locate(raw: string): { named?: NamedDir; unreadable?: string } {
  const probe = (candidate: string): 'directory' | 'file' | 'missing' => {
    try {
      const stat = statSync(candidate, { throwIfNoEntry: false })
      if (stat === undefined) return 'missing'
      return stat.isDirectory() ? 'directory' : 'file'
    } catch {
      return 'missing'
    }
  }
  const kind = probe(raw)
  if (kind === 'directory') return { named: { raw, path: resolve(raw), kind: 'directory' } }
  if (kind === 'file') {
    const parent = resolve(raw, '..')
    if (probe(parent) === 'directory') return { named: { raw, path: parent, kind: 'parent-of-file' } }
  }
  return { unreadable: raw }
}

/**
 * One row's scope reading, from the two cells that decide it.
 *
 * Exported because `rewrite-rehearsal` reads its split proposals through the same function: a
 * proposed in-repo half is only useful if its own `下一步` sits inside its own `仓库路径`.
 */
export function readScope(nextStep: string, repoPath: string): Omit<ScopeReading, 'id' | 'title'> {
  const fact = inspectRepoPath(repoPath)
  const roots = fact.candidates.filter((candidate) => candidate.kind === 'directory').map((candidate) => candidate.path)
  const named: NamedDir[] = []
  const unreadable: string[] = []
  for (const raw of pathsIn(nextStep)) {
    const located = locate(raw)
    if (located.named !== undefined) named.push(located.named)
    else if (located.unreadable !== undefined) unreadable.push(located.unreadable)
  }
  const outside = named.filter((entry) => !roots.some((root) => contains(root, entry.path))).map((entry) => entry.path)
  const verdict: ScopeReading['verdict'] =
    named.length === 0 ? 'silent' : roots.length === 0 ? 'no-root' : outside.length === 0 ? 'aligned' : 'drift'
  return { roots, rootReason: fact.reason, named, outside, unreadable, verdict }
}

/** Every row of a dump, in table order. */
export function auditRecords(records: readonly Record<string, unknown>[]): ScopeReading[] {
  return records.map((record) => {
    const item = normalizeItem(record)
    return { id: item.id, title: item.title, ...readScope(item.nextStep, item.repoPath) }
  })
}

/** Every row of a dump that the scheduler would poll. */
export function dueIds(records: readonly Record<string, unknown>[]): string[] {
  return records.filter((record) => normalizeItem(record).intervalMin > 0).map((record) => normalizeItem(record).id)
}

export function tally(readings: readonly ScopeReading[]): Record<ScopeReading['verdict'], number> {
  const counts: Record<ScopeReading['verdict'], number> = { aligned: 0, drift: 0, 'no-root': 0, silent: 0 }
  for (const reading of readings) counts[reading.verdict] += 1
  return counts
}

export function renderReport(dump: string, readings: readonly ScopeReading[], due: ReadonlySet<string>): string {
  const lines: string[] = []
  const counts = tally(readings)
  const dueReadings = readings.filter((reading) => due.has(reading.id))
  const dueCounts = tally(dueReadings)
  lines.push('scope-audit — is 仓库路径 the directory that 下一步 touches?')
  lines.push(`dump: ${dump}`)
  lines.push('')
  lines.push(
    `rows ${readings.length} · aligned ${counts.aligned} · drift ${counts.drift} · no-root ${counts['no-root']} · silent ${counts.silent}`,
  )
  lines.push(
    `due  ${dueReadings.length} · aligned ${dueCounts.aligned} · drift ${dueCounts.drift} · no-root ${dueCounts['no-root']} · silent ${dueCounts.silent}`,
  )
  lines.push('silent = 下一步 names no directory on disk; the drift count is a floor, not a total')
  for (const verdict of ['drift', 'no-root'] as const) {
    const group = readings.filter((reading) => reading.verdict === verdict)
    lines.push('')
    lines.push(`--- ${verdict} (${group.length}) ---`)
    if (group.length === 0) lines.push('  (none)')
    for (const reading of group) {
      const mark = due.has(reading.id) ? 'due' : 'off'
      lines.push(`  ${reading.id} [${mark}] ${reading.title}`)
      lines.push(`    仓库路径 ${reading.roots.length > 0 ? reading.roots.join(' | ') : '(no directory)'} [${reading.rootReason}]`)
      for (const path of reading.outside) lines.push(`    下一步 names ${path} — outside every root`)
    }
  }
  const noisy = readings.filter((reading) => reading.unreadable.length > 0)
  lines.push('')
  lines.push(`--- path tokens that are not on disk (${noisy.reduce((sum, reading) => sum + reading.unreadable.length, 0)}, never counted) ---`)
  if (noisy.length === 0) lines.push('  (none)')
  for (const reading of noisy) lines.push(`  ${reading.id}: ${reading.unreadable.join(' | ')}`)
  return lines.join('\n')
}

const USAGE = `用法：
  node scripts/scope-audit.ts [--dump <ndjson>] [--due] [--json]

  --dump <path>  direction-table dump; default: newest under .artifacts/direction
  --due          只算调度器会轮询的行（巡检间隔 > 0）
  --json         一个 JSON 对象，而不是报告

只读：不写表、不开 Ticket、不改文件。退出码 0 = 审计跑完（drift 数是答案，不是失败）；2 = 参数或输入读不了。`

export function parseArgs(argv: string[]): { dump?: string; due: boolean; json: boolean; help: boolean } {
  const options: { dump?: string; due: boolean; json: boolean; help: boolean } = { due: false, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--due') options.due = true
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
  let options: { dump?: string; due: boolean; json: boolean; help: boolean }
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`scope-audit: ${(error as Error).message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const dump = resolve(options.dump ?? newestDump() ?? '')
  let readings: ScopeReading[]
  let records: Record<string, unknown>[]
  try {
    records = recordsFromDump(readFileSync(dump, 'utf8')).records
    readings = auditRecords(records)
  } catch (error) {
    console.error(`scope-audit: cannot audit ${dump || '(no dump found)'}: ${(error as Error).message}`)
    return 2
  }
  const due = new Set(dueIds(records))
  const shown = options.due ? readings.filter((reading) => due.has(reading.id)) : readings
  if (options.json) {
    console.log(JSON.stringify({ dump, rows: shown.length, tally: tally(shown), due: [...due], readings: shown }, null, 2))
    return 0
  }
  console.log(renderReport(dump, shown, due))
  return 0
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
