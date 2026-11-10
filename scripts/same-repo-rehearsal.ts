#!/usr/bin/env node
/**
 * same-repo-rehearsal — prove that one repo never becomes two open Tickets.
 *
 * The question this answers is the one Policy v3 leaves open before `acceptMode: auto`:
 * the direction table has several rows per repo, so "one row, one thread" is not enough to
 * keep a repo single-threaded. This rehearsal drives the real Engine path — `runRound()` →
 * `Policy.gate()` → `Assessor.assess()` → `openTicket()` — and not the Gate alone:
 *
 *   1. same repo, two rows, one arriving after the other   → first admits, second is refused
 *   2. same repo, two rows, two rounds launched at once    → one Ticket, one dispatch, truly overlapped
 *   3. that Ticket ended, a third row                     → admits again
 *   4. two allowlisted repos, two rounds launched at once → one open Ticket each, both admit
 *   5. two rows outside the allowlist                     → both `repo-not-autonomous`, no Ticket
 *
 * Every scenario prints each Trigger's verdict / reason / Ticket and the Ticket count, and the
 * process exits non-zero when any check fails, so the output can be pasted as evidence:
 *
 *   node scripts/same-repo-rehearsal.ts
 *
 * Row ids are content-addressed in the real Source, so every scenario uses its own row ids.
 * The Assessor is deliberately slow (60 ms): that window is where two rounds can overlap.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Engine, type DecisionRecord } from '../src/core/engine.ts'
import { DirectionPolicy } from '../src/core/policy.ts'
import type { Assignment, Ticket, Trigger } from '../src/core/model.ts'

/** The allowlist every scenario runs under; both prefixes are "own repositories". */
export const ALLOWED_REPOS = ['D:\\gitAll\\dsh-patrol', 'E:\\gitAll\\openeyes'] as const
const REPO = ALLOWED_REPOS[0]
const SIBLING = ALLOWED_REPOS[1]
/** A 现场 repository: not on the allowlist, so the repo layer must refuse it first. */
const OUTSIDE = 'E:\\repos\\on-site'
/** How long the Assessor takes; this is the window in which two rounds can overlap. */
const ASSESS_MS = 60
/** Fixed clock: Ticket timestamps and round ids stay comparable between runs. */
const NOW = new Date('2026-11-11T01:00:00.000Z')

export interface AssessWindow {
  threadKey: string
  startMs: number
  endMs: number
}

export interface Check {
  label: string
  expected: string
  actual: string
  ok: boolean
}

export interface ScenarioResult {
  name: string
  title: string
  note: string
  checks: Check[]
  decisions: DecisionRecord[]
  tickets: { id: string; threadKey: string; status: string; repoPath: string }[]
  /** Ticket ids handed to the sink, in order: one entry per started Assignment. */
  dispatches: string[]
  windows: AssessWindow[]
  /** Whether this scenario launched more than one round without awaiting in between. */
  concurrent: boolean
  /** Only meaningful when `concurrent`: overlap of the first two Assessments in flight. */
  overlapMs: number | null
  elapsedMs: number
  ok: boolean
}

/** One row of the direction table, as the real mapping shapes it. */
function trigger(rowId: string, repoPath: string, threadKey = `patrol:${rowId}`): Trigger {
  const facts = { authorization: '自主', collaboration: 'sparse', approval: '已通过', priority: 'P1', fake: false, nextStepPresent: true, intervalMin: 60, repoPath }
  return {
    id: `trg_${rowId}`,
    source: 'direction-table',
    threadKey,
    at: NOW.toISOString(),
    strength: 'explicit',
    meta: { origin: `row:${rowId}`, itemId: rowId, title: `方向 ${rowId}`, nextStep: '把这一步做完', repoPath, stage: '开发', facts },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => { setTimeout(done, ms) })
}

/** An Engine with an instrumented Assessor and a counting sink. Nothing else is stubbed. */
function makeEngine(options: { assessMs?: number } = {}) {
  const decisions: DecisionRecord[] = []
  const windows: AssessWindow[] = []
  const dispatches: string[] = []
  const assessMs = options.assessMs ?? ASSESS_MS
  const engine = new Engine({
    policy: new DirectionPolicy({ version: 'v3', autonomousRepos: ALLOWED_REPOS }),
    acceptMode: 'auto',
    now: () => NOW,
    assessor: {
      assess: async (candidate) => {
        const startMs = performance.now()
        await sleep(assessMs)
        windows.push({ threadKey: candidate.thread.key, startMs, endMs: performance.now() })
        const row = candidate.triggers[candidate.triggers.length - 1]
        return {
          kind: 'accept',
          title: String(row?.meta['title'] ?? candidate.thread.key),
          scope: String(row?.meta['repoPath'] ?? ''),
          reason: 'row-carries-next-step',
          rules: ['next-step-present'],
        }
      },
    },
    sink: {
      start: (ticket: Ticket, _assignment: Assignment) => { dispatches.push(ticket.id) },
    },
    onDecision: (decision) => decisions.push(decision),
  })
  return { engine, decisions, windows, dispatches }
}

function check(label: string, expected: unknown, actual: unknown): Check {
  const wanted = JSON.stringify(expected)
  const got = JSON.stringify(actual)
  return { label, expected: wanted, actual: got, ok: wanted === got }
}

function snapshot(engine: Engine): ScenarioResult['tickets'] {
  return engine.tickets().map((ticket) => ({
    id: ticket.id,
    threadKey: ticket.threadKey,
    status: ticket.status,
    repoPath: ticket.repoPath ?? '',
  }))
}

function openCount(tickets: ScenarioResult['tickets']): number {
  return tickets.filter((ticket) => ticket.status !== 'ended').length
}

/** Wall-clock overlap of the first two Assessments that were in flight, in milliseconds. */
function overlapOf(windows: AssessWindow[]): number | null {
  if (windows.length < 2) return null
  const [first, second] = [...windows].sort((a, b) => a.startMs - b.startMs)
  if (!first || !second) return null
  return Math.max(0, Math.min(first.endMs, second.endMs) - Math.max(first.startMs, second.startMs))
}

function finish(base: Omit<ScenarioResult, 'ok' | 'overlapMs' | 'windows'>, windows: AssessWindow[]): ScenarioResult {
  return { ...base, windows, overlapMs: base.concurrent ? overlapOf(windows) : null, ok: base.checks.every((entry) => entry.ok) }
}

/** 1. Two rows of the same repo, the second arriving after the first Ticket is open. */
async function sequentialSameRepo(): Promise<ScenarioResult> {
  const { engine, decisions, windows, dispatches } = makeEngine({ assessMs: 5 })
  const first = trigger('recA1', REPO)
  const second = trigger('recA2', REPO)
  engine.receive(first)
  const round1 = await engine.runRound(NOW)
  engine.receive(second)
  const round2 = await engine.runRound(NOW)

  const tickets = snapshot(engine)
  const refused = decisions.find((decision) => decision.triggerId === second.id)
  return finish({
    name: 'same-repo-sequential',
    title: '同仓两行，第二条在第一条开票之后到达',
    note: 'runRound() 两次，中间 receive 第二条；这条路径不依赖并发',
    concurrent: false,
    decisions,
    tickets,
    dispatches,
    elapsedMs: 0,
    checks: [
      check('第一条 verdict', 'admitted', decisions.find((decision) => decision.triggerId === first.id)?.verdict),
      check('第一条 round admitted 计数', 1, round1.admitted),
      check('第二条 verdict', 'ignored', refused?.verdict),
      check('第二条 reason', 'ticket-already-open', refused?.reason),
      check('第二条 round admitted 计数', 0, round2.admitted),
      check('open ticket 数', 1, openCount(tickets)),
      check('ticket 总数', 1, tickets.length),
      check('派发次数', 1, dispatches.length),
    ],
  }, windows)
}

/** 2. Two rows of the same repo, two rounds launched without an intervening await. */
async function concurrentSameRepo(): Promise<ScenarioResult> {
  const { engine, decisions, windows, dispatches } = makeEngine()
  const first = trigger('recB1', REPO)
  const second = trigger('recB2', REPO)
  engine.receive(first)
  engine.receive(second)

  const startedAt = performance.now()
  // Both calls are created before either is awaited: the second round enters the Gate while the
  // first one sits inside the 60 ms Assessor, which is exactly the interleaving that must not
  // produce a second Ticket.
  const rounds = Promise.all([engine.runRound(NOW), engine.runRound(NOW)])
  const summaries = await rounds
  const elapsedMs = performance.now() - startedAt

  const tickets = snapshot(engine)
  const admitted = decisions.filter((decision) => decision.verdict === 'admitted')
  const refused = decisions.filter((decision) => decision.verdict !== 'admitted')
  const winner = admitted[0]?.triggerId
  const refusedRows = [...new Set(refused.map((decision) => decision.triggerId))].sort()
  const loser = refusedRows.find((entry) => entry !== winner)
  return finish({
    name: 'same-repo-concurrent',
    title: '同仓两行，两轮 runRound() 同时发起（不 await 中间）',
    note: `runRound() ×2 同时发起；assessor 各等 ${ASSESS_MS}ms；rounds=${summaries.length}`,
    concurrent: true,
    decisions,
    tickets,
    dispatches,
    elapsedMs,
    checks: [
      check('admitted 决策数（开票提交只有一次）', 1, admitted.length),
      check('非 admitted 的 reason 集合', ['ticket-already-open'], [...new Set(refused.map((decision) => decision.reason))]),
      check('被拒的行（含竞态落败的那一行）', ['recB1', 'recB2'], refusedRows.map((id) => id.replace(/^trg_/, ''))),
      check('落败者不是唯一的赢家', true, loser !== undefined),
      check('open ticket 数', 1, openCount(tickets)),
      check('ticket 总数', 1, tickets.length),
      check('派发次数（一个 ticket 只派发一次）', 1, dispatches.length),
      check('两条 Assessment 时间窗重叠 > 0', true, (overlapOf(windows) ?? 0) > 0),
    ],
  }, windows)
}

/** 3. After the Ticket ends, the next same-repo row may open a new one. */
async function afterTicketEnded(): Promise<ScenarioResult> {
  const { engine, decisions, windows, dispatches } = makeEngine({ assessMs: 5 })
  const first = trigger('recC1', REPO)
  engine.receive(first)
  await engine.runRound(NOW)
  const ticket = engine.tickets()[0]!

  const second = trigger('recC2', REPO)
  engine.receive(second)
  await engine.runRound(NOW)
  const refused = decisions.find((decision) => decision.triggerId === second.id)

  engine.endTicket(ticket.id, 'person', 'complete')

  const third = trigger('recC3', REPO)
  engine.receive(third)
  const round3 = await engine.runRound(NOW)
  const admitted = decisions.find((decision) => decision.triggerId === third.id)
  const tickets = snapshot(engine)

  return finish({
    name: 'after-end',
    title: 'ticket ended 之后，同仓第三条才能再次放行',
    note: 'open → 第二条被挡 → endTicket(person) → 第三条 admitted',
    concurrent: false,
    decisions,
    tickets,
    dispatches,
    elapsedMs: 0,
    checks: [
      check('第二条 reason', 'ticket-already-open', refused?.reason),
      check('end 之后 ticket 状态', 'ended', tickets[0]?.status),
      check('第三条 verdict', 'admitted', admitted?.verdict),
      check('第三条 round admitted 计数', 1, round3.admitted),
      check('ticket 总数（含已结束）', 2, tickets.length),
      check('open ticket 数', 1, openCount(tickets)),
      check('派发次数', 2, dispatches.length),
    ],
  }, windows)
}

/** 4. Two allowlisted repos, two rounds at once: neither repo blocks the other. */
async function concurrentDifferentRepos(): Promise<ScenarioResult> {
  const { engine, decisions, windows, dispatches } = makeEngine()
  engine.receive(trigger('recD1', REPO))
  engine.receive(trigger('recD2', SIBLING))

  const startedAt = performance.now()
  await Promise.all([engine.runRound(NOW), engine.runRound(NOW)])
  const elapsedMs = performance.now() - startedAt

  const tickets = snapshot(engine)
  const admitted = decisions.filter((decision) => decision.verdict === 'admitted')
  const perRepo = ALLOWED_REPOS.map((repo) => tickets.filter((ticket) => ticket.repoPath === repo && ticket.status !== 'ended').length)
  return finish({
    name: 'different-repos-concurrent',
    title: '两个都在白名单的不同 repo，同时发起互不影响',
    note: 'runRound() ×2 同时发起；两个 repo 各开一条',
    concurrent: true,
    decisions,
    tickets,
    dispatches,
    elapsedMs,
    checks: [
      check('admitted 决策数', 2, admitted.length),
      check('admitted 的 repo 集合', [REPO, SIBLING], admitted.map((decision) => decision.ticketId).map((id) => tickets.find((ticket) => ticket.id === id)?.repoPath).sort()),
      check('每个 repo 的 open ticket 数', [1, 1], perRepo),
      check('ticket 总数', 2, tickets.length),
      check('派发次数', 2, dispatches.length),
      check('两条 Assessment 时间窗重叠 > 0', true, (overlapOf(windows) ?? 0) > 0),
    ],
  }, windows)
}

/** 5. Two rows outside the allowlist, both rounds at once: the repo layer refuses both. */
async function concurrentOutsideAllowlist(): Promise<ScenarioResult> {
  const { engine, decisions, windows, dispatches } = makeEngine()
  engine.receive(trigger('recE1', OUTSIDE))
  engine.receive(trigger('recE2', OUTSIDE))

  await Promise.all([engine.runRound(NOW), engine.runRound(NOW)])
  const tickets = snapshot(engine)
  return finish({
    name: 'outside-allowlist-concurrent',
    title: '白名单外的同仓两行，两轮同时发起',
    note: '仓库层在 ticket 层之前；仓库层拒绝不需要 Assessment，所以两个 round 都没有进入 assessor',
    concurrent: true,
    decisions,
    tickets,
    dispatches,
    elapsedMs: 0,
    checks: [
      check('决策数（两行各判一次）', 2, decisions.length),
      check('verdict 集合', ['ignored'], [...new Set(decisions.map((decision) => decision.verdict))]),
      check('reason 集合', ['repo-not-autonomous'], [...new Set(decisions.map((decision) => decision.reason))]),
      check('被拒的行', ['recE1', 'recE2'], [...new Set(decisions.map((decision) => decision.triggerId.replace(/^trg_/, '')))].sort()),
      check('ticket 数', 0, tickets.length),
      check('派发次数', 0, dispatches.length),
    ],
  }, windows)
}

export const SCENARIOS: { name: string; title: string; run: () => Promise<ScenarioResult> }[] = [
  { name: 'same-repo-sequential', title: '同仓两行，先后到达', run: sequentialSameRepo },
  { name: 'same-repo-concurrent', title: '同仓两行，同时到达', run: concurrentSameRepo },
  { name: 'after-end', title: 'ticket ended 之后再次放行', run: afterTicketEnded },
  { name: 'different-repos-concurrent', title: '不同 repo 并行', run: concurrentDifferentRepos },
  { name: 'outside-allowlist-concurrent', title: '白名单外同仓', run: concurrentOutsideAllowlist },
]

export async function runScenario(name: string): Promise<ScenarioResult> {
  const scenario = SCENARIOS.find((entry) => entry.name === name)
  if (!scenario) throw new Error(`unknown scenario: ${name}`)
  return scenario.run()
}

export async function runRehearsal(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const scenario of SCENARIOS) results.push(await scenario.run())
  return results
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}ms`
}

/** Text report: one block per scenario, every Trigger's verdict, and the checks behind it. */
export function formatReport(results: ScenarioResult[]): string {
  const out: string[] = []
  out.push('same-repo rehearsal — one open Ticket per repo')
  out.push(`policy=v3  acceptMode=auto  allowlist=${ALLOWED_REPOS.join('; ')}`)
  out.push(`engine path: Engine.runRound() → Policy.gate() → Assessor.assess() → Engine.openTicket()`)
  out.push(`assessor delay=${ASSESS_MS}ms`)
  results.forEach((result, index) => {
    out.push('')
    out.push(`[${index + 1}] ${result.title}  (${result.name})`)
    out.push(`    ${result.note}`)
    for (const decision of result.decisions) {
      out.push(`    ${decision.triggerId.padEnd(12)} verdict=${decision.verdict.padEnd(9)} reason=${(decision.reason).padEnd(20)} ticket=${decision.ticketId ?? '-'}  round=${decision.roundId}`)
    }
    out.push(`    tickets=${result.tickets.length} open=${result.tickets.filter((ticket) => ticket.status !== 'ended').length}  dispatched=${result.dispatches.length}`)
    for (const ticket of result.tickets) out.push(`      ${ticket.id}  ${ticket.status.padEnd(8)} ${ticket.repoPath}`)
    if (result.concurrent && result.windows.length === 0) {
      out.push('    assessor windows: none — every row was refused by the repo layer before the Assessment')
    } else if (result.concurrent) {
      out.push(`    assessor windows: ${result.windows.map((window) => `${window.threadKey}[${(window.startMs).toFixed(1)}..${(window.endMs).toFixed(1)}]`).join('  ')}`)
      out.push(`    overlap=${ms(result.overlapMs)}  elapsed=${ms(result.elapsedMs)}  (assessor delay=${ASSESS_MS}ms; overlap>0 means at least two assessments were in flight at once)`)
    }
    for (const entry of result.checks) {
      out.push(`    ${entry.ok ? 'PASS' : 'FAIL'} ${entry.label}: expected ${entry.expected}, actual ${entry.actual}`)
    }
    out.push(`    ${result.ok ? 'OK' : 'FAILED'}`)
  })
  const failed = results.filter((result) => !result.ok)
  out.push('')
  out.push(`scenarios=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
  return `${out.join('\n')}\n`
}

const USAGE = `usage: node scripts/same-repo-rehearsal.ts

Drives the real Engine path (runRound → gate → assess → openTicket) through five scenarios and
exits non-zero when any check fails. No network, no Bitable, no dispatcher, no auto mode change.
`

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const results = await runRehearsal()
  process.stdout.write(formatReport(results))
  return results.every((result) => result.ok) ? 0 : 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entry && entry === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
    process.stderr.write(`same-repo-rehearsal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
