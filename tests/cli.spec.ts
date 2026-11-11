import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeAchievement, main, resolveSettings, type CliDeps, type CliIo } from '../src/cli.ts'

let dir = ''
let tasksFile = ''
let out = ''
let err = ''

const io: CliIo = {
  out: (text) => { out += `${text}\n` },
  err: (text) => { err += `${text}\n` },
}

function deps(extra: CliDeps = {}): CliDeps {
  return { env: { PATROL_TASKS_FILE: tasksFile }, now: () => new Date(2026, 10, 11, 3, 20), ...extra }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-cli-'))
  tasksFile = join(dir, 'items.json')
  await writeFile(tasksFile, await readFile(new URL('./fixtures/items.json', import.meta.url), 'utf8'), 'utf8')
  out = ''
  err = ''
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('patrol CLI', () => {
  it('lists rows with the fields the skill says it needs', async () => {
    expect(await main(['rows'], io, deps())).toBe(0)
    expect(out).toContain('row-1 | P0 | 自主/sparse/已通过 | 示例方向 A')
    expect(out).toContain('下一步：跑一轮 dry-run')
    expect(out).toContain('row-2 | P1 | 需审批/approve/待审 | 示例方向 B')
  })

  it('emits the whole row list as JSON with --json', async () => {
    expect(await main(['rows', '--json'], io, deps())).toBe(0)
    const parsed = JSON.parse(out) as Array<{ id: string; title: string }>
    expect(parsed.map((row) => row.id)).toEqual(['row-1', 'row-2'])
  })

  it('shows one row in full, and fails with exit 2 on an unknown id', async () => {
    expect(await main(['row', 'row-2'], io, deps())).toBe(0)
    expect(out).toContain('待审行动: 等审批')
    expect(out).toContain('外部成就:\n上一轮做过一轮')
    out = ''
    expect(await main(['row', 'nope'], io, deps())).toBe(2)
    expect(err).toContain('没有 id 为 nope 的行')
  })

  it('shows the 动作类型 cell, and names why there is none', async () => {
    expect(await main(['row', 'row-1'], io, deps())).toBe(0)
    expect(out).toContain('动作类型: （空：列值缺失或为空）')
  })

  it('writes the canonical action type and refuses a value outside the vocabulary', async () => {
    expect(await main(['report', 'row-1', '--action-type', ' Repo-Code '], io, deps())).toBe(0)
    let rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]?.['actionType']).toBe('repo-code')

    err = ''
    expect(await main(['report', 'row-1', '--action-type', 'auto'], io, deps())).toBe(2)
    expect(err).toContain('未知动作类型')
    expect(err).toContain('repo-code / repo-test')
    // A refused flag writes nothing: the row keeps the value it had.
    rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]?.['actionType']).toBe('repo-code')
  })

  it('appends a timestamped achievement and updates the other fields', async () => {
    const code = await main(['report', 'row-1', '--stage', '已实现', '--next', '补 CLI 测试', '--achievement', '新增 patrol CLI'], io, deps())
    expect(code).toBe(0)
    const rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({
      id: 'row-1',
      currentStage: '已实现',
      nextStep: '补 CLI 测试',
      achievement: '[2026-11-11 03:20]\n新增 patrol CLI',
    })
    // The untouched row must survive byte-for-byte in meaning.
    expect(rows[1]).toMatchObject({ id: 'row-2', achievement: '上一轮做过一轮' })
  })

  it('appends after an existing achievement unless --replace is given', async () => {
    await main(['report', 'row-2', '--achievement', '第二轮'], io, deps())
    let rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[1]?.['achievement']).toBe('上一轮做过一轮\n\n[2026-11-11 03:20]\n第二轮')
    await main(['report', 'row-2', '--achievement', '只留这条', '--replace'], io, deps())
    rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[1]?.['achievement']).toBe('只留这条')
  })

  it('refuses a report with nothing to write, and a missing source config', async () => {
    expect(await main(['report', 'row-1'], io, deps())).toBe(2)
    expect(err).toContain('没有可写字段')
    err = ''
    expect(await main(['rows'], io, { env: {} })).toBe(2)
    expect(err).toContain('bitable 数据源需要')
  })

  it('reads achievement from stdin when the value is -', async () => {
    const code = await main(['report', 'row-1', '--achievement', '-'], io, deps({ readStdin: async () => '来自标准输入' }))
    expect(code).toBe(0)
    const rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]?.['achievement']).toBe('[2026-11-11 03:20]\n来自标准输入')
  })

  it('strips a UTF-8 BOM from an achievement file so it never reaches the cell', async () => {
    const file = join(dir, 'with-bom.md')
    await writeFile(file, '\uFEFF带 BOM 的结果', 'utf8')
    expect(await main(['report', 'row-1', '--achievement-file', file], io, deps())).toBe(0)
    const rows = JSON.parse(await readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]?.['achievement']).toBe('[2026-11-11 03:20]\n带 BOM 的结果')
  })
})

describe('resolveSettings', () => {
  it('infers local-json from a tasks file and lets flags beat the environment', () => {
    const settings = resolveSettings({ 'base-token': 'flag-token' }, {
      PATROL_TASKS_FILE: 'C:\\rows.json',
      PATROL_SOURCE: 'bitable',
      PATROL_BASE_TOKEN: 'env-token',
      PATROL_TABLE_ID: 'tbl',
    })
    expect(settings).toMatchObject({ kind: 'bitable', baseToken: 'flag-token', tableId: 'tbl' })
    expect(resolveSettings({}, { PATROL_TASKS_FILE: 'C:\\rows.json' })).toMatchObject({ kind: 'local-json' })
  })
})

describe('composeAchievement', () => {
  it('keeps an empty existing value simple and trims the new text', () => {
    expect(composeAchievement('', '  做了事  ', new Date(2026, 10, 11, 3, 20), false)).toBe('[2026-11-11 03:20]\n做了事')
    expect(composeAchievement('旧', '新', new Date(2026, 10, 11, 3, 20), true)).toBe('新')
  })
})
