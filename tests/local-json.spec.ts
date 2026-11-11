import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTION_KINDS } from '../src/core/action-vocabulary.ts'
import { LocalJsonFileSource, LocalJsonSource } from '../src/source/local-json.ts'

/**
 * The file source is a direction table with the same write contract as Bitable.
 *
 * The CLI validates `--action-type` before it calls a source, so the CLI tests cannot prove this:
 * they exercise the flag, not the table. The rule the vocabulary states is about the *write path*
 * ("a tenth spelling cannot appear"), and `LocalJsonFileSource.writeBack()` is one of the two write
 * paths — so it is tested here, directly, with a value the vocabulary does not name.
 */

let dir = ''
let file = ''

/** Two rows, so "the other row survives" is checked as well as "the target row is unchanged". */
const ROWS = [
  { id: 'rec1', title: '示例方向 A', nextStep: '跑一轮 dry-run', priority: 'P0', intervalMin: 60 },
  { id: 'rec2', title: '示例方向 B', nextStep: '补一个单测', priority: 'P1', intervalMin: 60 },
]

async function readRows(): Promise<Record<string, unknown>[]> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-json-'))
  file = join(dir, 'items.json')
  await writeFile(file, `${JSON.stringify(ROWS, null, 2)}\n`, 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LocalJsonFileSource · the 动作类型 write path', () => {
  it('refuses every value outside the vocabulary and leaves the file byte-for-byte unchanged', async () => {
    const source = new LocalJsonFileSource({ path: file })
    const before = await readFile(file, 'utf8')

    // The near misses a person actually types, plus the historical word the Gate used to read as
    // a column value: none of them may reach the file.
    for (const value of ['auto', '待定', 'Repo Code', 'repo_code', 'repo-code!', 'repo-code--']) {
      await expect(source.writeBack('rec1', { actionType: value })).rejects.toThrow(/不在词表内/)
      expect(await readFile(file, 'utf8')).toBe(before)
    }

    const rows = await readRows()
    expect(rows[0]?.['actionType']).toBeUndefined()
    expect(rows[1]?.['actionType']).toBeUndefined()
  })

  it('refuses a refused value even when the same call carries fields that are legal', async () => {
    const source = new LocalJsonFileSource({ path: file })
    const before = await readFile(file, 'utf8')
    // Validation happens before any cell is touched, so the legal fields must not land either: a
    // half-written row (`当前阶段` updated, `动作类型` refused) is worse than a refused call.
    await expect(source.writeBack('rec1', { currentStage: '已实现', actionType: 'auto' })).rejects.toThrow(/不在词表内/)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('stores a recoverable variant as its canonical spelling, and keeps the other fields writing', async () => {
    const source = new LocalJsonFileSource({ path: file })
    await source.writeBack('rec1', { actionType: ' Repo-Code ', currentStage: '已实现' })

    const rows = await readRows()
    expect(rows[0]).toMatchObject({ id: 'rec1', actionType: 'repo-code', currentStage: '已实现' })
    // The untouched row survives, and the row that was written keeps its own next step.
    expect(rows[1]).toMatchObject({ id: 'rec2', nextStep: '补一个单测' })
    expect(rows[0]?.['nextStep']).toBe('跑一轮 dry-run')
  })

  it('accepts every canonical spelling, one at a time, so the rule is not a one-value allowance', async () => {
    const source = new LocalJsonFileSource({ path: file })
    for (const kind of ACTION_KINDS) {
      await source.writeBack('rec2', { actionType: kind })
      const rows = await readRows()
      expect(rows[1]?.['actionType']).toBe(kind)
    }
  })

  it('leaves a read-only source refusing write-back altogether', async () => {
    const source = new LocalJsonSource({ path: file })
    await expect(source.writeBack('rec1', { actionType: 'repo-code' })).rejects.toThrow(/write-back is not supported/)
  })
})
