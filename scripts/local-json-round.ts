#!/usr/bin/env node
/**
 * local-json-round — one Policy round over the `local-json` source, tallied by refusal reason.
 *
 * Observe mode exists to accumulate decision history before the gate opens, and the question that
 * history has to answer is not "how many rows were held" but "what is holding them". The repo layer
 * is the largest single answer, and it has two shapes a human fixes differently: a cell the Gate
 * cannot resolve to exactly one directory (`repo-path-ambiguous`) and a directory that is not there
 * (`repo-missing`). This script runs the real `Engine` under the real `DirectionPolicy` and reports
 * those two as a share of everything the Gate ignored — the measure the direction row asks for.
 *
 * The round runs on the **source**, not on a dump reader: a direction-table dump is converted to the
 * same local-json format the CLI and the fixture tests use, written once, and read back through
 * `LocalJsonSource`, so the facts the Gate sees are the ones a local-json round would produce.
 *
 *   node scripts/local-json-round.ts --tasks-file tests/items.json
 *   node scripts/local-json-round.ts --dump                                  # newest under .artifacts/direction
 *   node scripts/local-json-round.ts --dump <dump.ndjson> --repos 'D:\gitAll;E:\gitAll'
 *   node scripts/local-json-round.ts --dump <dump.ndjson> --any-repo --json
 *
 * Two things this deliberately does not do: it never dispatches (a Ticket is reported, never
 * started) and never writes back to the row (`LocalJsonSource` is the read-only class).
 *
 * `--any-repo` is the same diagnostic opt-in `shadow-run.mjs` has: it turns the allowlist layer off
 * (pre-v3 rule) so the repo *fact* layer can be measured alone. Without it, a row outside `--repos`
 * is refused as `repo-not-autonomous` before its cell is probed at all.
 *
 * Exit codes: 0 the round ran, 2 usage or unreadable input.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { newestDump, parseDump } from './repo-cell-audit.mjs'
import { Engine, type DecisionRecord, type RoundSummary } from '../src/core/engine.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import { itemIsDue, itemIsStopped, itemToTrigger } from '../src/mapping.ts'
import { LocalJsonSource } from '../src/source/local-json.ts'
import type { DirectionItem } from '../src/source/provider.ts'

/** Where a converted dump lands when `--out` is not given. */
const DEFAULT_OUT_DIR = '.artifacts/local-json'

/**
 * The dump's column names, read the way `BitableSource` reads them.
 *
 * Kept in step with `src/source/bitable.ts`: this table *is* the bitable source's input, and a
 * converter that mapped columns differently would measure a table nobody runs.
 */
const COLUMNS: Record<string, string> = {
  id: 'record_id',
  title: '项目名',
  description: '简要描述',
  nextStep: '下一步',
  priority: '优先级',
  intervalMin: '巡检间隔(分钟)',
  repoPath: '仓库路径',
  threadId: 'codex_thread_id',
  fake: '假数据模式',
  currentStage: '当前阶段',
  achievement: '外部成就',
  authorization: '授权边界',
  collaboration: '协作形态',
  approval: '审批状态',
  userNote: '用户批注',
  contribution: '贡献类型',
  actionType: '动作类型',
  pendingAction: '待审行动',
  category: '分类',
  lastRun: '最近执行时间',
}

/**
 * The repo-fact layer's own refusal reasons (`RepoExistsReason`, plus the "no fact at all" case).
 *
 * `repo-not-autonomous` / `repo-allowlist-unset` are the *allowlist* layer, not a fact about the
 * cell, so they stay out of this family: a row refused for them was never probed.
 */
export const REPO_FACT_REASONS = [
  'repo-empty-cell',
  'repo-missing',
  'repo-not-a-directory',
  'repo-path-unreachable',
  'repo-path-ambiguous',
  'repo-path-relative-unresolved',
  'repo-not-local-path',
  'repo-not-cloned',
  'repo-exists-unknown',
] as const

/** The half a human fixes by splitting a cell or dropping a note. */
export const AMBIGUOUS_REASONS = ['repo-path-ambiguous'] as const
/** The half a human fixes by cloning or mounting the directory. */
export const MISSING_REASONS = ['repo-missing'] as const

export interface LocalJsonRoundArgs {
  tasksFile?: string
  dump?: string
  out?: string
  repos: string[]
  anyRepo: boolean
  acceptMode: 'off' | 'observe' | 'auto'
  policyVersion: string
  json: boolean
  help?: boolean
}

/**
 * A Bitable cell as the source reads it: the first segment only.
 *
 * `BitableSource.listItems()` does `Array.isArray(value) ? value[0] ?? '' : value`, so a cell typed
 * as several paragraphs reaches the Gate as its first paragraph. Mirroring that is the point of this
 * converter — reading the whole cell here would report refusals no real round would produce. The
 * segmentation is counted separately (`multiSegment`) so the loss is visible rather than silent.
 */
export function cellOf(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0]
    if (first === null || first === undefined) return ''
    if (typeof first === 'object') return JSON.stringify(first)
    return String(first)
  }
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Whether a cell arrived as more than one segment, i.e. whether `cellOf()` dropped something. */
export function isMultiSegment(value: unknown): boolean {
  return Array.isArray(value) && value.filter((entry) => entry !== null && entry !== undefined && String(entry).trim() !== '').length > 1
}

/** One dump line → one local-json record (the shape `normalizeItem()` reads). */
export function recordFromDumpRow(row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = row[column]
    record[key] = key === 'fake' ? value === true : value === undefined || value === null ? '' : cellOf(value)
  }
  // `record_id` is the row id on the table; an empty one would collapse rows into one thread key.
  if (String(record['id'] ?? '') === '') record['id'] = cellOf(row['record_id'])
  return record
}

/** A dump → the local-json array, plus the cells whose extra segments the source drops. */
export function recordsFromDump(text: string): { records: Record<string, unknown>[]; multiSegment: string[] } {
  const rows = parseDump(text)
  const records: Record<string, unknown>[] = []
  const multiSegment: string[] = []
  for (const row of rows) {
    const id = cellOf(row['record_id']).trim()
    if (id === '') continue
    records.push(recordFromDumpRow(row))
    if (isMultiSegment(row['仓库路径'])) multiSegment.push(id)
  }
  return { records, multiSegment }
}

/** Ignored rows by reason, most frequent first, ties broken by the reason string. */
export function reasonTally(decisions: readonly DecisionRecord[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const decision of decisions) {
    if (decision.verdict !== 'ignored') continue
    counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => ({ reason, count }))
}

/** One decimal place, and `0` rather than `NaN` when the denominator is empty. */
export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part * 1000) / whole) / 10
}

export interface RepoFactShare {
  /** Every ignored decision: the denominator. */
  ignored: number
  ambiguous: number
  missing: number
  /** Repo-fact refusals that are neither the ambiguous nor the missing shape. */
  otherRepoFact: number
  /** The whole repo-fact layer, i.e. `ambiguous + missing + otherRepoFact`. */
  repoFactBlocked: number
  ambiguousShare: number
  missingShare: number
  repoFactShare: number
  /** Why the remaining ignored rows were refused, most frequent first. */
  nonRepoFact: { reason: string; count: number }[]
}

/**
 * The measure the direction row asks for, computed from the tally.
 *
 * Reads the published reason vocabulary and nothing else: a reason that is not in
 * `REPO_FACT_REASONS` lands in `nonRepoFact`, so a Gate change shows up here as an unexplained
 * bucket instead of being silently counted as a repo fact.
 */
export function repoFactShare(tally: readonly { reason: string; count: number }[]): RepoFactShare {
  const of = (family: readonly string[]): number =>
    tally.filter((entry) => (family as readonly string[]).includes(entry.reason)).reduce((sum, entry) => sum + entry.count, 0)
  const ignored = tally.reduce((sum, entry) => sum + entry.count, 0)
  const ambiguous = of(AMBIGUOUS_REASONS)
  const missing = of(MISSING_REASONS)
  const repoFactBlocked = of(REPO_FACT_REASONS)
  return {
    ignored,
    ambiguous,
    missing,
    otherRepoFact: repoFactBlocked - ambiguous - missing,
    repoFactBlocked,
    ambiguousShare: percent(ambiguous, ignored),
    missingShare: percent(missing, ignored),
    repoFactShare: percent(repoFactBlocked, ignored),
    nonRepoFact: tally.filter((entry) => !(REPO_FACT_REASONS as readonly string[]).includes(entry.reason)),
  }
}

export interface RoundCounts {
  rows: number
  due: number
  stopped: number
  notDue: number
}

export interface RoundResult {
  summary: RoundSummary
  decisions: DecisionRecord[]
  counts: RoundCounts
}

/**
 * Runs one observe round over a local-json file.
 *
 * The due/stopped split is `PatrolRunner.runOnce()`'s, not a shortcut: a stopped row is recorded and
 * never judged, and a row whose interval has not elapsed is not received at all. Judging every row
 * would put `schedule-stopped` in the ignored tally and make the repo-fact share meaningless.
 *
 * The Assessor is the same stand-in `shadow-run.mjs` uses — accept iff the row carries a next step —
 * so the tally measures the Gate, which is the layer under test. No dispatcher is wired: observe mode
 * opens no Ticket anyway, and this script must not become a way to start work.
 */
export async function runLocalJsonRound(options: {
  file: string
  repos?: readonly string[]
  anyRepo?: boolean
  acceptMode?: 'off' | 'observe' | 'auto'
  policyVersion?: string
  now?: Date
}): Promise<RoundResult> {
  const source = new LocalJsonSource({ path: options.file })
  const decisions: DecisionRecord[] = []
  const engine = new Engine({
    policy: new DirectionPolicy({
      version: options.policyVersion ?? 'v5-shadow',
      autonomousRepos: options.repos ?? [],
      allowAnyRepo: options.anyRepo ?? false,
    }),
    assessor: {
      // The Gate refuses a row with no next step before this runs; the branch is here so an
      // accept is never produced for an empty action line even if the order changes.
      assess: async (candidate) => {
        const nextStep = String(candidate.triggers[0]?.meta['nextStep'] ?? '').trim()
        if (!nextStep) return { kind: 'ignore', reason: 'no-next-step' }
        return {
          kind: 'accept',
          title: String(candidate.triggers[0]?.meta['title'] ?? ''),
          scope: String(candidate.triggers[0]?.meta['repoPath'] ?? ''),
          reason: 'row-carries-next-step',
          rules: ['next-step-present'],
        }
      },
    },
    acceptMode: options.acceptMode ?? 'observe',
    onDecision: (decision) => decisions.push(decision),
  })

  const items: DirectionItem[] = await source.listItems()
  const now = options.now ?? new Date()
  const due = items.filter((item) => itemIsDue(item, now))
  const stopped = items.filter((item) => itemIsStopped(item))
  for (const item of due) engine.receive(itemToTrigger(item, now.toISOString()))
  const summary = await engine.runRound(now, { stopped: stopped.map((item) => itemToTrigger(item, now.toISOString())) })

  return {
    summary,
    decisions,
    counts: { rows: items.length, due: due.length, stopped: stopped.length, notDue: items.length - due.length - stopped.length },
  }
}

export interface ReportInput {
  source: string
  dump?: string
  multiSegment?: readonly string[]
  policyVersion: string
  acceptMode: string
  repos: readonly string[]
  anyRepo: boolean
  result: RoundResult
  tally: readonly { reason: string; count: number }[]
  share: RepoFactShare
}

/** The human report: what ran, what was held, and what the repo layer accounts for. */
export function renderReport(input: ReportInput): string {
  const { summary, counts } = input.result
  const lines: string[] = []
  lines.push(`source: local-json  ${input.source}`)
  if (input.dump) {
    const extra = input.multiSegment && input.multiSegment.length > 0
      ? `  (${input.multiSegment.length} 仓库路径 cells are multi-segment; the source reads the first)`
      : ''
    lines.push(`from dump: ${input.dump}${extra}`)
  }
  const allow = input.anyRepo
    ? '(any repo: diagnostic opt-in, the allowlist layer is off)'
    : input.repos.length > 0 ? input.repos.join(' | ') : '(none: every row is refused as repo-allowlist-unset)'
  lines.push(`policy: ${input.policyVersion}  acceptMode: ${input.acceptMode}  allowlist: ${allow}`)
  lines.push(`rows=${counts.rows}  due=${counts.due}  stopped=${counts.stopped}  not-due=${counts.notDue}`)
  lines.push(
    `evaluated=${summary.evaluated}  observed=${summary.observed}  ignored=${summary.ignored}  ` +
      `admitted=${summary.admitted}  unavailable=${summary.unavailable}  tickets=${summary.tickets.length}`,
  )
  lines.push('--- ignored, by reason ---')
  if (input.tally.length === 0) lines.push('  (nothing was ignored)')
  for (const { reason, count } of input.tally) lines.push(`  ${String(count).padStart(4)}  ${reason}`)
  lines.push('--- repo fact share of ignored ---')
  lines.push(
    `repo-fact blocked = ${input.share.repoFactBlocked}/${input.share.ignored} ignored = ${input.share.repoFactShare}%  ` +
      `(ambiguous ${input.share.ambiguous} = ${input.share.ambiguousShare}%, ` +
      `missing ${input.share.missing} = ${input.share.missingShare}%, ` +
      `other ${input.share.otherRepoFact} = ${percent(input.share.otherRepoFact, input.share.ignored)}%)`,
  )
  if (input.share.nonRepoFact.length > 0) {
    lines.push('held by something other than the repo fact:')
    for (const { reason, count } of input.share.nonRepoFact) lines.push(`  ${String(count).padStart(4)}  ${reason}`)
  }
  // A count nobody can act on is half a report: the rows are what a human edits, so name them.
  const repoRows = input.result.decisions.filter(
    (decision) => decision.verdict === 'ignored' && (REPO_FACT_REASONS as readonly string[]).includes(decision.reason),
  )
  if (repoRows.length > 0) {
    lines.push('--- refused by the repo fact, by row ---')
    for (const decision of repoRows) {
      const id = decision.recordId ?? decision.threadKey
      lines.push(`  ${id}  ${decision.reason}`)
    }
  }
  return lines.join('\n')
}

function flagValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

/** Flag parsing, kept separate so a test can assert defaults without touching disk. */
export function parseArgs(argv: string[]): LocalJsonRoundArgs {
  const options: LocalJsonRoundArgs = {
    repos: [],
    anyRepo: false,
    acceptMode: 'observe',
    policyVersion: 'v5-shadow',
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    switch (arg) {
      case '--tasks-file': options.tasksFile = flagValue(argv, index, arg); index += 1; break
      case '--dump': {
        // A bare `--dump` means "the newest dump": the everyday rerun should not need a filename.
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) { options.dump = ''; break }
        options.dump = next
        index += 1
        break
      }
      case '--out': options.out = flagValue(argv, index, arg); index += 1; break
      case '--repos': options.repos = flagValue(argv, index, arg).split(/[;,]/).map((repo) => repo.trim()).filter(Boolean); index += 1; break
      case '--policy': options.policyVersion = flagValue(argv, index, arg); index += 1; break
      case '--accept-mode': {
        const value = flagValue(argv, index, arg)
        if (value !== 'off' && value !== 'observe' && value !== 'auto') throw new Error(`--accept-mode must be off|observe|auto, got ${value}`)
        options.acceptMode = value
        index += 1
        break
      }
      case '--any-repo': options.anyRepo = true; break
      case '--json': options.json = true; break
      case '--help':
      case '-h': options.help = true; break
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!options.tasksFile && options.dump === undefined) throw new Error('one of --tasks-file or --dump is required')
  if (options.tasksFile !== undefined && options.dump !== undefined) throw new Error('--tasks-file and --dump are alternatives; pick one')
  return options
}

/** The local-json path a dump converts to: the dump's own name, so two dumps never overwrite. */
export function outPathFor(dumpPath: string, out?: string): string {
  if (out) return out
  const name = basename(dumpPath, extname(dumpPath))
  return `${DEFAULT_OUT_DIR}/${name}.json`
}

const USAGE = `usage: node scripts/local-json-round.ts (--tasks-file <items.json> | --dump [<dump.ndjson>]) [options]
  --tasks-file <path>   a local-json direction file (read-only source, no write-back)
  --dump [<path>]       a direction-table ndjson dump; omitted path means the newest under
                        .artifacts/direction. Converted to local-json first, then read as that source
  --out <path>          where the converted local-json lands (default ${DEFAULT_OUT_DIR}/<dump>.json)
  --repos <a;b>         the allowlist this round runs under (default: none, which refuses every row)
  --any-repo            diagnostic opt-in: turn the allowlist layer off, measure the repo fact alone
  --policy <version>    policy version to stamp on decisions (default v5-shadow)
  --accept-mode <mode>  off|observe|auto (default observe; auto would open Tickets)
  --json                print the report as one JSON object`

async function main(argv: string[]): Promise<number> {
  let options: LocalJsonRoundArgs
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`local-json-round: ${(error as Error).message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  let source = options.tasksFile ? resolve(options.tasksFile) : ''
  let dump: string | undefined
  let multiSegment: string[] = []
  try {
    if (options.dump !== undefined) {
      const dumpPath = options.dump === '' ? newestDump() : options.dump
      if (!dumpPath) throw new Error('no ndjson dump under .artifacts/direction; pass --dump <path>')
      dump = resolve(dumpPath)
      const converted = recordsFromDump(readFileSync(dump, 'utf8'))
      multiSegment = converted.multiSegment
      source = resolve(outPathFor(dump, options.out))
      mkdirSync(dirname(source), { recursive: true })
      writeFileSync(source, `${JSON.stringify(converted.records, null, 2)}\n`, 'utf8')
    }
  } catch (error) {
    console.error(`local-json-round: cannot read ${dump ?? options.tasksFile}: ${(error as Error).message}`)
    return 2
  }

  let result: RoundResult
  try {
    result = await runLocalJsonRound({
      file: source,
      repos: options.repos,
      anyRepo: options.anyRepo,
      acceptMode: options.acceptMode,
      policyVersion: options.policyVersion,
    })
  } catch (error) {
    console.error(`local-json-round: the round failed: ${(error as Error).message}`)
    return 2
  }

  const tally = reasonTally(result.decisions)
  const share = repoFactShare(tally)
  const input: ReportInput = {
    source,
    dump,
    multiSegment,
    policyVersion: options.policyVersion,
    acceptMode: options.acceptMode,
    repos: options.repos,
    anyRepo: options.anyRepo,
    result,
    tally,
    share,
  }
  if (options.json) {
    // `decisions` is the per-row half: a script that wants to act on the tally needs the row ids,
    // and recomputing the round to get them would judge every row twice.
    console.log(JSON.stringify({ source, dump, multiSegment, policy: options.policyVersion, acceptMode: options.acceptMode, repos: options.repos, anyRepo: options.anyRepo, counts: result.counts, summary: result.summary, tally, share, decisions: result.decisions }, null, 2))
    return 0
  }
  console.log(renderReport(input))
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
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
