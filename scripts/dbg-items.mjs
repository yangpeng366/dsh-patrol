import { BitableSource } from '../lib/index.js'
const source = new BitableSource({ baseToken: process.env.PATROL_BASE_TOKEN, tableId: process.env.PATROL_TABLE_ID, identity: 'user' })
const items = await source.listItems()
console.log('rows =', items.length)
console.log('有下一步的行 =', items.filter((i) => i.nextStep.trim()).length)
for (const it of items.slice(0, 6)) {
  console.log(`  id=${it.id} title=${it.title} | next="${it.nextStep.slice(0, 30)}" | auth=${it.authorization} collab=${it.collaboration} appr=${it.approval} | stage=${it.currentStage} | prio=${it.priority} interval=${it.intervalMin}`)
}