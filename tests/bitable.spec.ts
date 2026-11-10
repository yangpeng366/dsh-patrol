import { describe, expect, it } from 'vitest'
import { BitableSource } from '../src/source/bitable.ts'

/** A captured `lark-cli base +record-list --format json` payload. */
const payload = {
  ok: true,
  data: {
    fields: ['record_id', '项目名', '优先级', '巡检间隔(分钟)', '授权边界', '协作形态', '审批状态', '下一步', '外部成就', '当前阶段', '假数据模式'],
    data: [
      ['rec1', 'networkx', ['P1'], 1440, ['自主'], ['sparse'], ['已通过'], '开一个 PR', '历史成就', ['开发'], false],
      ['rec2', 'fastjson2', ['P2'], 0, ['自主'], ['approve'], ['待审'], '', '', ['维护'], false],
    ],
  },
}

describe('BitableSource', () => {
  it('maps the table columns onto the neutral item contract', async () => {
    const source = new BitableSource({
      baseToken: 'base',
      tableId: 'table',
      exec: async () => ({ stdout: JSON.stringify(payload) }),
    })
    const items = await source.listItems()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'rec1',
      title: 'networkx',
      priority: 'P1',
      intervalMin: 1440,
      authorization: '自主',
      collaboration: 'sparse',
      approval: '已通过',
      nextStep: '开一个 PR',
      currentStage: '开发',
    })
    expect(items[1]).toMatchObject({ id: 'rec2', priority: 'P2', collaboration: 'approve', approval: '待审' })
  })

  it('passes the identity and table to the CLI', async () => {
    const calls: { file: string; args: string[] }[] = []
    const source = new BitableSource({
      baseToken: 'base',
      tableId: 'table',
      identity: 'bot',
      exec: async (file, args) => { calls.push({ file, args }); return { stdout: JSON.stringify(payload) } },
    })
    await source.listItems()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain('--as')
    expect(calls[0]!.args).toContain('bot')
    expect(calls[0]!.args).toContain('table')
  })
})