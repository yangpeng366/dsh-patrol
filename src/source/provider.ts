/**
 * The row-shaped contract every source must produce.
 *
 * Deliberately the same shape as patrol-scaffold's item contract (`schemas/item.schema.json`),
 * so a source implementation can be shared between the two projects instead of forked.
 */
export type Priority = 'P0' | 'P1' | 'P2'

/** One direction row. */
export interface DirectionItem {
  /** Stable id of the source row (Bitable record id, file key, ...). */
  id: string
  title: string
  description: string
  /** The row's own action line. Empty means there is nothing concrete to do yet. */
  nextStep: string
  priority: Priority
  /**
   * Shortest polling interval in minutes. 0 means the row's schedule is stopped (停跑): the table
   * writes 0/blank for a row it does not want polled, and its `巡检占用` column says so in words.
   * Policy v4 refuses a stopped row with `schedule-stopped`; it never reads 0 as "every round".
   */
  intervalMin: number
  repoPath: string
  /** Executor session id to resume, when the row has one. */
  threadId: string | null
  /** Dry-run flag from the row. */
  fake: boolean
  /** ISO timestamp of the row's last run, when known. */
  lastRun: string | null
  /** Where the work stands. */
  currentStage: string
  /** Accumulated results, written back after a round. */
  achievement: string
  /** `自主` / `需审批` / `只读`. */
  authorization: string
  /** `sparse` / `dense` / `approve`. */
  collaboration: string
  /** `待审` / `已通过` / `已忽略` / `阻塞`. */
  approval: string
  /** `用户批注` — free-form history and instructions the row's owner wrote on it. */
  userNote: string
  /** `贡献类型` — the source's own tag for the contribution, e.g. `功能增强` / `测试补充`. */
  contribution: string
  /**
   * `动作类型` — the source's structured action kind, when the table has that column.
   *
   * `undefined` means "no structured answer": either the column does not exist yet, or the cell is
   * blank. A source must not invent a value here, and a row with a value is not re-read from prose:
   * the column wins (`src/core/action-facts.ts`).
   */
  actionType?: string
  /** The action waiting for a human decision, if any. */
  pendingAction: string
  /** Free-form category, e.g. `工作项目` / `兴趣研究`. */
  category: string
}

/** Fields the engine may write back to a row. `actionType` writes the structured `动作类型` cell. */
export type WriteBackField = 'currentStage' | 'nextStep' | 'achievement' | 'threadId' | 'actionType'

/** A row-shaped task source. */
export interface SourceProvider {
  /** Stable provider id, e.g. `bitable` or `local-json`. */
  readonly kind: string
  /** Reads every row the source exposes. */
  listItems(signal?: AbortSignal): Promise<DirectionItem[]>
  /** Writes results back to one row. Implementations must be idempotent per row. */
  writeBack(id: string, fields: Partial<Record<WriteBackField, string>>, signal?: AbortSignal): Promise<void>
}

/** Fills in the defaults a source may omit. */
export function normalizeItem(raw: Record<string, unknown>): DirectionItem {
  const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
  const priorityRaw = str(raw['priority']).trim().toUpperCase()
  const priority: Priority = priorityRaw === 'P0' || priorityRaw === 'P1' ? priorityRaw : 'P2'
  const intervalRaw = Number(raw['intervalMin'])
  return {
    id: str(raw['id']).trim(),
    title: str(raw['title']).trim(),
    description: str(raw['description']),
    nextStep: str(raw['nextStep']).trim(),
    priority,
    intervalMin: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : 0,
    repoPath: str(raw['repoPath']),
    threadId: raw['threadId'] === null || raw['threadId'] === undefined || str(raw['threadId']) === '' ? null : str(raw['threadId']),
    fake: raw['fake'] === true,
    lastRun: raw['lastRun'] === null || raw['lastRun'] === undefined || str(raw['lastRun']) === '' ? null : str(raw['lastRun']),
    currentStage: str(raw['currentStage']),
    achievement: str(raw['achievement']),
    authorization: str(raw['authorization']) || '自主',
    collaboration: str(raw['collaboration']) || 'sparse',
    approval: str(raw['approval']) || '已通过',
    userNote: str(raw['userNote']),
    contribution: str(raw['contribution']),
    // Blank and missing are the same thing: no structured answer. Keeping `''` would make a row
    // indistinguishable from a typo, and the classifier reads `undefined` as "column absent".
    actionType: str(raw['actionType']).trim() === '' ? undefined : str(raw['actionType']).trim(),
    pendingAction: str(raw['pendingAction']),
    category: str(raw['category']),
  }
}