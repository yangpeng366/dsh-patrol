/**
 * The `bitable` source: a Feishu Bitable table of directions.
 *
 * Reads through `lark-cli base --as user`, so no tenant token and no app secret is involved —
 * the same identity path the rest of our tooling uses. The column names are the source's own
 * (`项目名` / `下一步` / `授权边界` / ...), mapped here into the neutral item contract.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { normalizeItem, type DirectionItem, type SourceProvider, type WriteBackField } from './provider.ts'
import { writeActionCell } from '../core/action-vocabulary.ts'

const run = promisify(execFile)

/**
 * Resolves how to run `lark-cli` on this machine.
 *
 * On Windows the CLI is installed as a shim (`lark-cli.cmd` / `lark-cli.ps1`), which Node cannot
 * spawn by bare name — it has to go through `cmd.exe`. Everywhere else the plain binary works.
 * `LARK_CLI` overrides both.
 */
export function resolveLarkCli(explicit?: string): { file: string; prefix: string[] } {
  const override = explicit ?? process.env['LARK_CLI']
  if (override) return { file: override, prefix: [] }
  if (process.platform === 'win32') return { file: 'cmd.exe', prefix: ['/c', 'lark-cli.cmd'] }
  return { file: 'lark-cli', prefix: [] }
}


export interface BitableSourceOptions {
  baseToken: string
  tableId: string
  /** Row identity for `--as user`. */
  identity?: 'user' | 'bot'
  /** CLI binary; defaults to `lark-cli` on PATH. */
  larkCli?: string
  /** Command runner; injectable so tests need no CLI. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>
}

/** Column names this source understands. Missing columns degrade to empty values. */
const COLUMNS = {
  id: 'record_id',
  title: '项目名',
  description: '简要描述',
  nextStep: '下一步',
  priority: '优先级',
  intervalMin: '巡检间隔(分钟)',
  repoPath: '仓库路径',
  threadId: 'codex_thread_id',
  fake: '假数据模式',
  currentStage: '当前阶段',
  achievement: '外部成就',
  authorization: '授权边界',
  collaboration: '协作形态',
  approval: '审批状态',
  userNote: '用户批注',
  contribution: '贡献类型',
  /** Structured action kind. Optional: a table without the column reads as "no structured answer". */
  actionType: '动作类型',
  pendingAction: '待审行动',
  category: '分类',
  lastRun: '最近执行时间',
} as const

/** Row-shaped source backed by a Feishu Bitable table. */
export class BitableSource implements SourceProvider {
  readonly kind = 'bitable'
  private readonly options: BitableSourceOptions
  private readonly exec: (file: string, args: string[]) => Promise<{ stdout: string }>
  private readonly command: { file: string; prefix: string[] }

  constructor(options: BitableSourceOptions) {
    this.options = options
    this.exec = options.exec ?? ((file, args) => run(file, args, { maxBuffer: 64 * 1024 * 1024 }))
    this.command = resolveLarkCli(options.larkCli)
  }

  async listItems(signal?: AbortSignal): Promise<DirectionItem[]> {
    signal?.throwIfAborted()
    const items: DirectionItem[] = []
    const limit = 100
    // `record-list` answers with a matrix plus a parallel `record_id_list`; the row id is NOT a column,
    // so it must be read from that list. `has_more` drives paging.
    for (let offset = 0; offset < 100 * limit; offset += limit) {
      const args = [
        'base', '+record-list',
        '--as', this.options.identity ?? 'user',
        '--base-token', this.options.baseToken,
        '--table-id', this.options.tableId,
        '--offset', String(offset),
        '--limit', String(limit),
        '--format', 'json',
      ]
      const { stdout } = await this.exec(this.command.file, [...this.command.prefix, ...args])
      const payload = JSON.parse(stdout) as {
        ok?: boolean
        data?: { data?: unknown[][]; fields?: string[]; record_id_list?: string[]; has_more?: boolean }
        error?: unknown
      }
      if (payload.ok === false) throw new Error(`BitableSource: lark-cli failed: ${JSON.stringify(payload.error ?? payload)}`)
      const rows = payload.data?.data ?? []
      const fields = payload.data?.fields ?? []
      const recordIds = payload.data?.record_id_list ?? []
      rows.forEach((row, index) => {
        const byName: Record<string, unknown> = {}
        fields.forEach((name, cellIndex) => { byName[name] = row[cellIndex] })
        const record: Record<string, unknown> = {}
        for (const [key, column] of Object.entries(COLUMNS)) {
          const value = byName[column]
          record[key] = Array.isArray(value) ? (value[0] ?? '') : value
        }
        record['id'] = recordIds[index] ?? byName['record_id'] ?? ''
        items.push(normalizeItem(record))
      })
      if (!payload.data?.has_more || rows.length === 0) break
    }
    return items
  }

  async writeBack(id: string, fields: Partial<Record<WriteBackField, string>>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const payload: Record<string, string> = {}
    if (fields.currentStage !== undefined) payload['当前阶段'] = fields.currentStage
    if (fields.nextStep !== undefined) payload['下一步'] = fields.nextStep
    if (fields.achievement !== undefined) payload['外部成就'] = fields.achievement
    if (fields.threadId !== undefined) payload['codex_thread_id'] = fields.threadId
    // One of the two write paths for `动作类型` (the other is `LocalJsonFileSource`), and neither
    // can write a tenth option: `writeActionCell()` either returns one of the nine canonical
    // spellings or throws before a request is made.
    if (fields.actionType !== undefined) payload['动作类型'] = writeActionCell(fields.actionType)
    if (Object.keys(payload).length === 0) return

    const dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-'))
    const file = join(dir, 'payload.json')
    try {
      await writeFile(file, JSON.stringify(payload), 'utf8')
      await this.exec(this.command.file, [...this.command.prefix,
        'base', '+record-upsert',
        '--as', this.options.identity ?? 'user',
        '--base-token', this.options.baseToken,
        '--table-id', this.options.tableId,
        '--record-id', id,
        '--json', `@${file}`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Reads one row's raw JSON, for diagnostics. */
  async readRaw(id: string): Promise<string> {
    const { stdout } = await this.exec(this.command.file, [...this.command.prefix,
      'base', '+record-get',
      '--as', this.options.identity ?? 'user',
      '--base-token', this.options.baseToken,
      '--table-id', this.options.tableId,
      '--record-id', id,
      '--format', 'json',
    ])
    return stdout
  }
}

/** Reads a file written by another process; used by tests. */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}