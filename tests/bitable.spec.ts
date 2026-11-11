import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BitableSource } from '../src/source/bitable.ts'

/** A captured `lark-cli base +record-list --format json` payload. The row id is NOT a column. */
const payload = {
  ok: true,
  data: {
    fields: ['项目名', '优先级', '巡检间隔(分钟)', '授权边界', '协作形态', '审批状态', '下一步', '外部成就', '当前阶段', '假数据模式'],
    record_id_list: ['rec1', 'rec2'],
    has_more: false,
    data: [
      ['networkx', ['P1'], 1440, ['自主'], ['sparse'], ['已通过'], '开一个 PR', '历史成就', ['开发'], false],
      ['fastjson2', ['P2'], 0, ['自主'], ['approve'], ['待审'], '', '', ['维护'], false],
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

  it('takes the row id from record_id_list, not from a column', async () => {    const source = new BitableSource({
      baseToken: 'base',
      tableId: 'table',
      exec: async () => ({ stdout: JSON.stringify(payload) }),
    })
    const items = await source.listItems()
    expect(items.map((item) => item.id)).toEqual(['rec1', 'rec2'])
  })

  it('pages while the table reports more rows', async () => {
    const calls: string[][] = []
    const source = new BitableSource({
      baseToken: 'base',
      tableId: 'table',
      exec: async (_file, args) => {
        calls.push(args)
        const offset = Number(args[args.indexOf('--offset') + 1])
        if (offset === 0) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                fields: ['项目名'],
                record_id_list: ['r1'],
                has_more: true,
                data: [['first']],
              },
            }),
          }
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { fields: ['项目名'], record_id_list: ['r2'], has_more: false, data: [['second']] },
          }),
        }
      },
    })
    const items = await source.listItems()
    expect(items.map((item) => item.title)).toEqual(['first', 'second'])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('100')
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

  // The structured column is optional: the table may not have it yet, and that must read as "no
  // structured answer" instead of as an error or as an empty string the classifier could misread.
  it('reads the 动作类型 column when the table has one, and leaves it undefined when it does not', async () => {
    const withColumn = {
      ok: true,
      data: {
        fields: ['项目名', '动作类型'],
        record_id_list: ['rec1', 'rec2'],
        has_more: false,
        data: [['有值', [' repo-test ']], ['空格', ['']]],
      },
    }
    const source = new BitableSource({ baseToken: 'base', tableId: 'table', exec: async () => ({ stdout: JSON.stringify(withColumn) }) })
    const items = await source.listItems()
    expect(items[0]!.actionType).toBe('repo-test')
    expect(items[1]!.actionType).toBeUndefined()

    const withoutColumn = new BitableSource({ baseToken: 'base', tableId: 'table', exec: async () => ({ stdout: JSON.stringify(payload) }) })
    const legacy = await withoutColumn.listItems()
    expect(legacy.every((item) => item.actionType === undefined)).toBe(true)
  })

  // The write path is the other end of the same vocabulary: a canonical spelling goes into the
  // column as-is, and anything else is refused before a request can create a tenth option.
  it('writes only a canonical 动作类型 spelling and refuses one outside the vocabulary', async () => {
    const written: unknown[] = []
    const source = new BitableSource({
      baseToken: 'base',
      tableId: 'table',
      exec: async (_file, args) => {
        const at = args.find((arg) => arg.startsWith('@'))
        if (at) written.push(JSON.parse(readFileSync(at.slice(1), 'utf8'))['动作类型'])
        return { stdout: '{}' }
      },
    })
    await source.writeBack('rec1', { actionType: ' Repo-Code ' })
    expect(written).toEqual(['repo-code'])

    await expect(source.writeBack('rec1', { actionType: 'auto' })).rejects.toThrow(/不在词表内/)
    // The refused write never reached the CLI: still exactly one payload.
    expect(written).toHaveLength(1)
  })
})
