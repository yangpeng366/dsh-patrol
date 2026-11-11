#!/usr/bin/env node
/**
 * `patrol` — the command line the dsh-patrol skill tells an agent to use.
 *
 * The plugin itself runs inside DSH and never needs this file. But the skill's first three
 * instructions (`patrol rows`, `patrol row <id>`, `patrol report <id>`) are what an agent does
 * before and after a round, and they need to work without a running DSH host. This CLI reads the
 * same source the plugin reads, and writes back through the same `SourceProvider` contract.
 *
 * Source selection is by flags first, environment second, so a skill can call the short form and
 * an operator can override without editing the skill.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ACTION_KINDS, readActionCell } from './core/action-vocabulary.ts'
import { BitableSource } from './source/bitable.ts'
import { LocalJsonFileSource } from './source/local-json.ts'
import type { DirectionItem, SourceProvider, WriteBackField } from './source/provider.ts'

export interface CliSettings {
  kind: 'bitable' | 'local-json'
  tasksFile: string
  baseToken: string
  tableId: string
  identity: 'user' | 'bot'
  larkCli?: string
}

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Reads `--achievement -`; injectable so tests need no real stdin. */
  readStdin?: () => Promise<string>
  /** Overrides source construction; tests use it to stand in a fake provider. */
  createSource?: (settings: CliSettings) => SourceProvider
}

/** A failure the CLI reports as a usage or input error rather than a crash. */
export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

const USAGE = `用法：
  patrol rows [--json]
  patrol row <id> [--json]
  patrol report <id> --stage <阶段> --next <下一行> [--achievement <文本|->] [--thread <id>] [--action-type <kind>] [--replace]

参数：
  --json                        输出机器可读的 JSON
  --replace                     覆盖“外部成就”，默认追加一条带时间的记录
  --action-type <kind>          回写“动作类型”列，只接受 ${ACTION_KINDS.join(' / ')}
                                （大小写与首尾空白会归一化；其它值直接报错，不写表）

数据源（命令行参数优先于环境变量）：
  --source local-json|bitable   PATROL_SOURCE
  --tasks-file <path>           PATROL_TASKS_FILE
  --base-token <token>          PATROL_BASE_TOKEN / BITABLE_BASE_TOKEN
  --table-id <id>               PATROL_TABLE_ID / BITABLE_TABLE_ID
  --identity user|bot           PATROL_IDENTITY
  --lark-cli <path>             LARK_CLI

退出码：0 成功；2 参数、配置或行不存在；1 运行期失败。`

type FlagValue = string | true
interface ParsedArgs {
  positionals: string[]
  flags: Record<string, FlagValue>
}

const BOOLEAN_FLAGS = new Set(['json', 'replace', 'help'])

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, FlagValue> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new CliError(`参数 --${body} 缺少值`)
    flags[body] = next
    index += 1
  }
  return { positionals, flags }
}

function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (value === true) throw new CliError(`参数 --${name} 缺少值`)
  return value
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** Resolves source settings from flags and environment. Exported for the config tests. */
export function resolveSettings(flags: Record<string, FlagValue>, env: NodeJS.ProcessEnv = process.env): CliSettings {
  const tasksFile = flagString(flags, 'tasks-file') ?? firstEnv(env, ['PATROL_TASKS_FILE']) ?? ''
  const declared = flagString(flags, 'source') ?? firstEnv(env, ['PATROL_SOURCE'])
  const kind = declared ?? (tasksFile ? 'local-json' : 'bitable')
  if (kind !== 'bitable' && kind !== 'local-json') {
    throw new CliError(`未知数据源：${kind}（可选 bitable / local-json）`)
  }
  const identity = flagString(flags, 'identity') ?? firstEnv(env, ['PATROL_IDENTITY']) ?? 'user'
  if (identity !== 'user' && identity !== 'bot') throw new CliError(`未知身份：${identity}（可选 user / bot）`)
  if (kind === 'local-json' && !tasksFile) throw new CliError('local-json 数据源需要 --tasks-file 或 PATROL_TASKS_FILE')
  const baseToken = flagString(flags, 'base-token') ?? firstEnv(env, ['PATROL_BASE_TOKEN', 'BITABLE_BASE_TOKEN']) ?? ''
  const tableId = flagString(flags, 'table-id') ?? firstEnv(env, ['PATROL_TABLE_ID', 'BITABLE_TABLE_ID']) ?? ''
  if (kind === 'bitable' && (!baseToken || !tableId)) {
    throw new CliError('bitable 数据源需要 --base-token / --table-id（或 PATROL_BASE_TOKEN / PATROL_TABLE_ID）')
  }
  return {
    kind,
    tasksFile,
    baseToken,
    tableId,
    identity,
    larkCli: flagString(flags, 'lark-cli') ?? firstEnv(env, ['LARK_CLI']),
  }
}

/** Builds the provider the settings name. Exported so the plugin and CLI stay on one path. */
export function createCliSource(settings: CliSettings): SourceProvider {
  if (settings.kind === 'local-json') return new LocalJsonFileSource({ path: settings.tasksFile })
  return new BitableSource({
    baseToken: settings.baseToken,
    tableId: settings.tableId,
    identity: settings.identity,
    larkCli: settings.larkCli,
  })
}

function findRow(items: DirectionItem[], id: string): DirectionItem {
  const row = items.find((item) => item.id === id)
  if (!row) throw new CliError(`没有 id 为 ${id} 的行`)
  return row
}

function renderRowLine(item: DirectionItem): string {
  const step = item.nextStep || '（无下一步）'
  return `${item.id} | ${item.priority} | ${item.authorization}/${item.collaboration}/${item.approval} | ${item.title}\n    下一步：${step}`
}

function renderRowDetail(item: DirectionItem): string {
  const lines = [
    `id: ${item.id}`,
    `标题: ${item.title}`,
    `分类: ${item.category || '（空）'}`,
    `优先级: ${item.priority}`,
    `授权/协作/审批: ${item.authorization} / ${item.collaboration} / ${item.approval}`,
    `仓库: ${item.repoPath || '（空）'}`,
    `动作类型: ${describeActionCell(item.actionType)}`,
    `当前阶段: ${item.currentStage || '（空）'}`,
    `下一步: ${item.nextStep || '（空）'}`,
    `待审行动: ${item.pendingAction || '（空）'}`,
    `会话: ${item.threadId ?? '（无）'}`,
    `最近执行: ${item.lastRun ?? '（无）'}`,
    `巡检间隔: ${item.intervalMin > 0 ? `${item.intervalMin} 分钟` : '停跑（0/空）'}`,
    `假数据: ${item.fake ? '是' : '否'}`,
    '描述:',
    item.description || '（空）',
    '外部成就:',
    item.achievement || '（空）',
  ]
  return lines.join('\n')
}

/**
 * One `动作类型` cell as a person needs to read it: the kind, or why there is none.
 *
 * `row` is the surface an operator uses to answer "what does the Gate see for this row", so an
 * unreadable cell has to look unreadable here — not blank, and not silently thrown away.
 */
function describeActionCell(value: string | undefined): string {
  const reading = readActionCell(value)
  switch (reading.state) {
    case 'missing': return '（空：列值缺失或为空）'
    case 'invalid': return `${reading.raw.trim()}（非法值，按 unclear 处理）`
    case 'normalized': return `${reading.kind}（由「${reading.raw.trim()}」归一化）`
    case 'valid': return `${reading.kind}`
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function stamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * Composes the `外部成就` value.
 *
 * The row's contract calls this field "accumulated", so the default appends a timestamped block
 * instead of erasing the previous round. `--replace` is for correcting a mistaken report.
 */
export function composeAchievement(existing: string, text: string, now: Date, replace: boolean): string {
  const body = text.trim()
  if (!body) return existing
  if (replace) return body
  const block = `[${stamp(now)}]\n${body}`
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function resolveAchievementText(flags: Record<string, FlagValue>, deps: CliDeps): Promise<string | undefined> {
  const file = flagString(flags, 'achievement-file')
  const inline = flagString(flags, 'achievement')
  if (file !== undefined && inline !== undefined) throw new CliError('--achievement 与 --achievement-file 只能给一个')
  if (file !== undefined) return stripBom(await readFile(file, 'utf8'))
  if (inline === '-') return stripBom(await (deps.readStdin ?? readStdinAll)())
  return inline
}

/** A UTF-8 BOM is invisible in an editor but would land in the cell as U+FEFF. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function has(flags: Record<string, FlagValue>, name: string): boolean {
  return flags[name] !== undefined
}

/** Runs one command. Returns the process exit code instead of calling `process.exit`. */
export async function main(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
    const [command, id] = parsed.positionals
    if (has(parsed.flags, 'help') || command === undefined || command === 'help') {
      io.out(USAGE)
      return command === undefined && !has(parsed.flags, 'help') ? 2 : 0
    }
    if (command !== 'rows' && command !== 'row' && command !== 'report') {
      throw new CliError(`未知命令：${command}\n\n${USAGE}`)
    }
    const settings = resolveSettings(parsed.flags, deps.env ?? process.env)
    const source = (deps.createSource ?? createCliSource)(settings)

    if (command === 'rows') {
      const items = await source.listItems()
      if (has(parsed.flags, 'json')) {
        io.out(JSON.stringify(items, null, 2))
      } else if (items.length === 0) {
        io.out('（没有行）')
      } else {
        io.out(items.map(renderRowLine).join('\n'))
      }
      return 0
    }

    if (!id) throw new CliError(`${command} 需要行 id`)
    const items = await source.listItems()
    const row = findRow(items, id)

    if (command === 'row') {
      io.out(has(parsed.flags, 'json') ? JSON.stringify(row, null, 2) : renderRowDetail(row))
      return 0
    }

    const stage = flagString(parsed.flags, 'stage')
    const next = flagString(parsed.flags, 'next')
    const thread = flagString(parsed.flags, 'thread')
    const actionType = flagString(parsed.flags, 'action-type')
    const text = await resolveAchievementText(parsed.flags, deps)
    const fields: Partial<Record<WriteBackField, string>> = {}
    if (stage !== undefined) fields.currentStage = stage
    if (next !== undefined) fields.nextStep = next
    if (thread !== undefined) fields.threadId = thread
    if (actionType !== undefined) {
      // The vocabulary is the contract: a value outside it is a usage error, not a cell to write
      // and let the next round discover. `readActionCell()` also folds case and surrounding space,
      // so `Repo-Code` writes `repo-code` instead of creating a tenth option in the column.
      const reading = readActionCell(actionType)
      if (reading.kind === undefined) {
        throw new CliError(`未知动作类型：${actionType || '(空)'}（可选 ${ACTION_KINDS.join(' / ')}）`)
      }
      fields.actionType = reading.kind
    }
    if (text !== undefined && text.trim() !== '') {
      fields.achievement = composeAchievement(row.achievement, text, (deps.now ?? (() => new Date()))(), has(parsed.flags, 'replace'))
    }
    if (Object.keys(fields).length === 0) {
      throw new CliError('report 没有可写字段：至少给 --stage、--next、--achievement、--thread 或 --action-type 之一')
    }
    await source.writeBack(row.id, fields)
    const result = { ok: true, id: row.id, fields }
    if (has(parsed.flags, 'json')) {
      io.out(JSON.stringify(result, null, 2))
    } else {
      io.out(`已回写 ${row.id}：${Object.keys(fields).join(', ')}`)
    }
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      io.err(`patrol: ${error.message}`)
      return error.exitCode
    }
    io.err(`patrol: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const code = await main(process.argv.slice(2), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  })
  process.exitCode = code
}
