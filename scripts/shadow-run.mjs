// One observe-mode shadow round against the real direction table: read-only, no dispatch, no write-back.
//
//   node scripts/shadow-run.mjs --log .artifacts/patrol-decisions.jsonl --repos 'E:\gitAll\openeyes'
//
// Policy v3 refuses every row when --repos is empty (repo-allowlist-unset). --any-repo restores the
// pre-v3 "any repo" rule for a diagnostic run, and is the only way this script opts in.
//
// A round normally exists only in the host log. With --log (or PATROL_DECISION_LOG) every
// DecisionRecord also lands in an append-only JSONL file, so scripts/policy-audit.mjs can
// read the round back and list what observe mode held for review.
import { BitableSource, createDecisionLog, createEngine, itemToTrigger } from '../lib/index.js'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback
}

const logPath = arg('log', process.env.PATROL_DECISION_LOG ?? '')
const policyVersion = arg('policy', 'v3-shadow')
const autonomousRepos = arg('repos', process.env.PATROL_AUTONOMOUS_REPOS ?? '')
  .split(/[;,]/)
  .map((repo) => repo.trim())
  .filter(Boolean)
const allowAnyRepo = process.argv.includes('--any-repo')

const source = new BitableSource({
  baseToken: process.env.PATROL_BASE_TOKEN,
  tableId: process.env.PATROL_TABLE_ID,
  identity: 'user',
})

const decisions = []
// createEngine only reads the policy name, pause flag and accept mode here; decisionLogPath is
// what createDecisionLog turns into a log, so both paths stay on the plugin's own wiring.
const config = {
  policyVersion,
  paused: false,
  acceptMode: 'observe',
  decisionLogPath: logPath,
  autonomousRepos,
  allowAnyRepo,
}
const decisionLog = createDecisionLog(config, {
  onError: (error) => console.error(`decision log write failed: ${String(error)}`),
})
const engine = createEngine(config, {
  assessor: {
    assess: async (candidate) => {
      const trigger = candidate.triggers[0]
      const nextStep = String(trigger?.meta?.nextStep ?? '').trim()
      if (!nextStep) return { kind: 'ignore', reason: 'no-next-step' }
      return {
        kind: 'accept',
        title: String(trigger?.meta?.title ?? ''),
        scope: String(trigger?.meta?.repoPath ?? ''),
        reason: 'row-carries-next-step',
        rules: ['next-step-present'],
      }
    },
  },
  onDecision: (d) => decisions.push(d),
  decisionLog,
})

const items = await source.listItems()
console.log(`rows read = ${items.length}`)
const now = new Date()
for (const item of items) {
  // Rows without a next step still get a Trigger, so the audit records why they were ignored
  // instead of dropping them before the Gate ever sees them.
  engine.receive(itemToTrigger(item, now.toISOString()))
}
const summary = await engine.runRound(now)
console.log(`evaluated=${summary.evaluated} observed=${summary.observed} ignored=${summary.ignored} admitted=${summary.admitted}`)
const byReason = {}
for (const d of decisions) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1
console.log('reasons =', JSON.stringify(byReason))
console.log(`autonomous repos = ${autonomousRepos.length ? autonomousRepos.join(' | ') : '(none: v3 refuses every row with repo-allowlist-unset)'}${allowAnyRepo ? ' [allowAnyRepo: diagnostic opt-in]' : ''}`)
console.log('would-accept (held for review):')
for (const d of decisions.filter((x) => x.verdict === 'observed')) {
  console.log(`  ${d.threadKey} :: ${d.wouldAccept?.title ?? ''} :: ${d.wouldAccept?.scope ?? ''}`)
}
console.log(`tickets opened = ${engine.tickets().length}  (observe mode must open none)`)
console.log(logPath
  ? `decisions logged to ${logPath} (${decisions.length} this round) - audit with: node scripts/policy-audit.mjs --file ${logPath}`
  : 'no decision log written (pass --log <path> to keep this round)')
