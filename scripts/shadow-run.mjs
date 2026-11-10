// One observe-mode shadow round against the real direction table: read-only, no dispatch, no write-back.
import { BitableSource, DirectionPolicy, Engine, itemToTrigger } from '../lib/index.js'

const source = new BitableSource({
  baseToken: process.env.PATROL_BASE_TOKEN,
  tableId: process.env.PATROL_TABLE_ID,
  identity: 'user',
})

const decisions = []
const policy = new DirectionPolicy({ version: 'shadow-2026-11-10' })
const engine = new Engine({
  policy,
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
  acceptMode: 'observe',
  onDecision: (d) => decisions.push(d),
})

const items = await source.listItems()
console.log(`rows read = ${items.length}`)
const now = new Date()
for (const item of items) {
  if (!item.nextStep.trim()) continue
  engine.receive(itemToTrigger(item, now.toISOString()))
}
const summary = await engine.runRound(now)
console.log(`evaluated=${summary.evaluated} observed=${summary.observed} ignored=${summary.ignored} admitted=${summary.admitted}`)
const byReason = {}
for (const d of decisions) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1
console.log('reasons =', JSON.stringify(byReason))
console.log('would-accept (held for review):')
for (const d of decisions.filter((x) => x.verdict === 'observed')) {
  console.log(`  ${d.threadKey} :: ${d.wouldAccept?.title ?? ''} :: ${d.wouldAccept?.scope ?? ''}`)
}
console.log(`tickets opened = ${engine.tickets().length}  (observe mode must open none)`)