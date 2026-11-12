/**
 * The decision layer's contract: one prompt, one format parser, two doors.
 *
 * These cases are the three answers the prompt can get — a clean one, one missing a field, and one
 * wrapped in noise — plus the refusals that must stay loud. The point is not to test a regex but to
 * pin the interface a skill and a CI run both depend on: the same five JSON keys, the same four
 * `E-*` codes, the same exit codes, offline and with no table configured.
 *
 * The last case guards the vocabulary rule: the prompt must name no action kind. The list is
 * imported, never copied, so this stays true when a kind is added or removed.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTION_KINDS } from '../src/core/action-vocabulary.ts'
import { DecisionParseError, parseDecisionAnswer } from '../src/core/decision-answer.ts'
import { main, type CliIo } from '../src/cli.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/parse-decision.ts', import.meta.url))
const PROMPT = fileURLToPath(new URL('../prompts/decide-next-action.md', import.meta.url))
const SCHEMA = fileURLToPath(new URL('../schemas/item.schema.json', import.meta.url))

/** 合规：三行齐全，没有杂音。 */
const GOOD = [
  '动作: 跑一遍 tests/parse-decision.spec.ts 确认三种回答都解析成约定 JSON',
  '理由: 先钉住格式，再谈判断质量',
  '人工介入: 否',
].join('\n')

/** 缺字段：少了「人工介入」。 */
const MISSING = [
  '动作: 补 docs/decision-prompt.md 的解析契约一节',
  '理由: 漏了人工介入这一行',
].join('\n')

/** 多行杂音：寒暄 + 代码围栏 + 事后解释，三行仍应被读到。 */
const NOISY = [
  '好的，按提示词回答如下：',
  '',
  '```text',
  '动作: 用 parse-decision.ts 解析这份回答，确认围栏里的三行能被读到',
  '理由: 模型经常把结果包在代码块里',
  '人工介入: 否',
  '```',
  '',
  '之所以这样选：仓库原先没有 prompts 目录，先落文件再验证。',
].join('\n')

let dir = ''
let out = ''
let err = ''

const io: CliIo = {
  out: (text) => { out += `${text}\n` },
  err: (text) => { err += `${text}\n` },
}

async function writeAnswer(name: string, text: string): Promise<string> {
  const file = join(dir, `${name}.txt`)
  await writeFile(file, text, 'utf8')
  return file
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-decision-'))
  out = ''
  err = ''
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('parseDecisionAnswer', () => {
  it('reads a clean answer into exactly the five keys downstream reads', () => {
    expect(parseDecisionAnswer(GOOD)).toEqual({
      action: '跑一遍 tests/parse-decision.spec.ts 确认三种回答都解析成约定 JSON',
      reason: '先钉住格式，再谈判断质量',
      needsHuman: false,
      skillNote: null,
      ignoredLines: [],
    })
  })

  it('keeps the optional 沉淀 line verbatim, and maps 是 to needsHuman', () => {
    const answer = parseDecisionAnswer([
      '动作: 发布前跑一次 release-check',
      '理由: 打包内容与版本号要一致',
      '人工介入: 是',
      '沉淀: - 改完脚本先跑离线自测 — pnpm vitest run tests/parse-decision.spec.ts',
    ].join('\n'))
    expect(answer.needsHuman).toBe(true)
    expect(answer.skillNote).toBe('- 改完脚本先跑离线自测 — pnpm vitest run tests/parse-decision.spec.ts')
    expect(answer.ignoredLines).toEqual([])
  })

  it('accepts the six documented flag spellings and folds case', () => {
    for (const [flag, expected] of [['是', true], ['否', false], ['YES', true], ['no', false], ['True', true], ['false', false]] as const) {
      const answer = parseDecisionAnswer(`动作: 做一件事\n理由: 为了验证标记\n人工介入: ${flag}`)
      expect(answer.needsHuman, flag).toBe(expected)
    }
  })

  it('tolerates CRLF, a BOM and full-width colons', () => {
    const answer = parseDecisionAnswer(`\uFEFF动作：跑一次只读探测\r\n理由：确认仓库位置\r\n人工介入：否\r\n`)
    expect(answer.action).toBe('跑一次只读探测')
    expect(answer.needsHuman).toBe(false)
  })

  it('names the missing field with a stable ASCII code', () => {
    let thrown: unknown
    try {
      parseDecisionAnswer(MISSING)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DecisionParseError)
    const error = thrown as DecisionParseError
    expect(error.code).toBe('E-MISSING-FIELD')
    expect(error.field).toBe('humanFlag')
    expect(error.message.startsWith('E-MISSING-FIELD:humanFlag|')).toBe(true)
  })

  it('refuses a duplicated field instead of picking one of two answers', () => {
    expect(() => parseDecisionAnswer([
      '动作: 跑自测',
      '动作: 改 README',
      '理由: 两条动作互相冲突',
      '人工介入: 否',
    ].join('\n'))).toThrow(/^E-DUPLICATE-FIELD:action\|/)
  })

  it('refuses a field that appeared with an empty value', () => {
    expect(() => parseDecisionAnswer([
      '动作: 补解析契约',
      '理由:   ',
      '人工介入: 否',
    ].join('\n'))).toThrow(/^E-EMPTY-FIELD:reason\|/)
  })

  it('refuses a flag that did not pick a side, including the template itself', () => {
    expect(() => parseDecisionAnswer('动作: 做一件事\n理由: 为了验证标记\n人工介入: 是 ｜ 否')).toThrow(/^E-BAD-FLAG:humanFlag\|/)
  })

  it('reads the three lines through noise and records every ignored line', () => {
    const answer = parseDecisionAnswer(NOISY)
    expect(answer.action).toBe('用 parse-decision.ts 解析这份回答，确认围栏里的三行能被读到')
    expect(answer.reason).toBe('模型经常把结果包在代码块里')
    expect(answer.needsHuman).toBe(false)
    expect(answer.skillNote).toBeNull()
    // 5: the greeting, two fences, the closing prose, and one blank line is not recorded at all.
    expect(answer.ignoredLines).toEqual([
      '好的，按提示词回答如下：',
      '```text',
      '```',
      '之所以这样选：仓库原先没有 prompts 目录，先落文件再验证。',
    ])
  })

  it('strips markdown decoration from a label and its value', () => {
    const answer = parseDecisionAnswer('- **动作**: 跑一次只读探测\n- **理由**: 先看仓库在不在\n- **人工介入**: 否')
    expect(answer.action).toBe('跑一次只读探测')
    expect(answer.reason).toBe('先看仓库在不在')
    expect(answer.needsHuman).toBe(false)
    expect(answer.ignoredLines).toEqual([])
  })
})

describe('scripts/parse-decision.ts', () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  }

  it('prints the JSON on stdout and exits 0 for a clean answer', async () => {
    const file = await writeAnswer('good', GOOD)
    const result = run([file])
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed).toEqual({
      action: '跑一遍 tests/parse-decision.spec.ts 确认三种回答都解析成约定 JSON',
      reason: '先钉住格式，再谈判断质量',
      needsHuman: false,
      skillNote: null,
      ignoredLines: [],
    })
  })

  it('exits 2 and prints the code for a malformed answer', async () => {
    const file = await writeAnswer('missing', MISSING)
    const result = run([file])
    expect(result.status).toBe(2)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr).toContain('E-MISSING-FIELD:humanFlag')
    // The ASCII half is the contract; the readable half follows the bar.
    expect(result.stderr).toContain('缺字段 人工介入')
  })

  it('exits 1 for a missing file and for no argument at all', async () => {
    const missingFile = run([join(dir, 'nope.txt')])
    expect(missingFile.status).toBe(1)
    expect(missingFile.stderr).toContain('E-INPUT-NOT-FOUND')

    const noArg = run([])
    expect(noArg.status).toBe(1)
    expect(noArg.stderr).toContain('E-NO-INPUT')
  })

  it('exits 0 and prints the usage for --help', () => {
    const result = run(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('parse-decision.ts <回答文件>')
  })
})

describe('patrol decide', () => {
  it('parses an answer file without any source configured', async () => {
    const file = await writeAnswer('good', NOISY)
    // No PATROL_TASKS_FILE and no --source: `decide` must not need a table.
    expect(await main(['decide', file], io, { env: {} })).toBe(0)
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed['action']).toBe('用 parse-decision.ts 解析这份回答，确认围栏里的三行能被读到')
    expect(parsed['needsHuman']).toBe(false)
    expect(parsed['ignoredLines']).toHaveLength(4)
  })

  it('exits 2 with the stable code, and 2 again when no file is named', async () => {
    const file = await writeAnswer('missing', MISSING)
    expect(await main(['decide', file], io, { env: {} })).toBe(2)
    expect(err).toContain('E-MISSING-FIELD:humanFlag')

    err = ''
    expect(await main(['decide'], io, { env: {} })).toBe(2)
    expect(err).toContain('decide 需要回答文件路径')
  })

  it('reports an unreadable path as an input error, not a crash', async () => {
    expect(await main(['decide', join(dir, 'nope.txt')], io, { env: {} })).toBe(2)
    expect(err).toContain('E-INPUT-NOT-FOUND')
  })
})

describe('prompts/decide-next-action.md', () => {
  it('declares the three required lines and the optional one', async () => {
    const prompt = await readFile(PROMPT, 'utf8')
    expect(prompt).toContain('动作: <')
    expect(prompt).toContain('理由: <')
    expect(prompt).toContain('人工介入: 是 ｜ 否')
    expect(prompt).toContain('沉淀: - <做法> — <命令>')
  })

  it('uses the item contract as its input fields', async () => {
    const prompt = await readFile(PROMPT, 'utf8')
    const schema = JSON.parse(await readFile(SCHEMA, 'utf8')) as { properties: Record<string, unknown> }
    for (const field of Object.keys(schema.properties)) {
      expect(prompt, `prompt is missing item field ${field}`).toContain(`${field}:`)
    }
  })

  it('defers the action kinds to the vocabulary instead of copying them', async () => {
    const prompt = await readFile(PROMPT, 'utf8')
    expect(prompt).toContain('src/core/action-vocabulary.ts')
    // A kind named as a standalone token would be a second copy of the vocabulary. A boundary
    // check keeps file names (e.g. a doc path containing "decision") from counting as the kind.
    for (const kind of ACTION_KINDS) {
      const token = new RegExp(`(?<![A-Za-z0-9_-])${kind.replaceAll('-', '\\-')}(?![A-Za-z0-9_-])`)
      expect(token.test(prompt), `prompt names the kind ${kind}`).toBe(false)
    }
  })

  it('is UTF-8 without a BOM', async () => {
    const bytes = await readFile(PROMPT)
    expect(bytes[0]).not.toBe(0xef)
  })
})
