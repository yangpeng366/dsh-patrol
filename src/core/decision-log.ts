/**
 * The decision log: every verdict the Engine reached, appended to one JSONL file.
 *
 * A round of the patrol is over as soon as it returns; what the Engine *decided* and *why* was
 * only ever visible in the host log. This module makes that decision history durable so
 * `scripts/policy-audit.mjs` can answer "which rows would `observe` mode accept?" from data
 * instead of from a re-run.
 *
 * Three properties matter more than speed here:
 *   - append-only: a record is never rewritten, so a history file can be tailed or diffed;
 *   - one line per decision, UTF-8 without BOM, so `Get-Content`/`jq`/`sort` all work;
 *   - a failed write never breaks the patrol: the failure comes back as a return value *and*,
 *     when a callback is configured, as a callback — it is never silently dropped.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { DecisionRecord } from './engine.ts'

/** One line of the JSONL file. `DecisionRecord` plus the facts the file itself must carry. */
export interface DecisionLogEntry {
  /** ISO 8601 timestamp of the write. */
  ts: string
  /** Round the decision belongs to; every decision of one `runRound` shares it. */
  roundId: string
  verdict: DecisionRecord['verdict']
  reason: string
  threadKey: string
  /** Present when the verdict was an accept held back for review (`observe` / `off`). */
  wouldAccept?: { title: string; scope: string; rules: string[] }
  triggerId: string
  evalId: string
  ticketId?: string
}

/** The outcome of one append. A failure is a value, not an exception. */
export type AppendResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; path: string; error: Error }

export interface DecisionLogOptions {
  /** File to append to. A relative path is resolved against `cwd` (see `resolveDecisionLogPath`). */
  path: string
  /** Base for a relative `path`; defaults to `process.cwd()`. */
  cwd?: string
  /** Clock, injectable for tests. */
  now?: () => Date
  /** Called with every failed write, in addition to the returned failure. */
  onError?: (error: Error, entry: DecisionLogEntry) => void
}

/**
 * Resolves a configured decision-log path.
 *
 * Rule (matches the rest of the plugin — `tasksFile` and the Bitable path handling are the same):
 * a relative path is resolved against the **process working directory**, not against the module
 * directory or the package root, so `dsh-patrol.decisions.jsonl` means the same file to the host
 * and to `node scripts/policy-audit.mjs --file` started from the same shell. Absolute paths are
 * used verbatim. `~` is **not** expanded: the host's shell does that, a plugin should not guess.
 */
export function resolveDecisionLogPath(path: string, cwd: string = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** Turns an engine decision into the line that gets written. */
export function toDecisionLogEntry(decision: DecisionRecord, ts: Date): DecisionLogEntry {
  const entry: DecisionLogEntry = {
    ts: ts.toISOString(),
    roundId: decision.roundId,
    verdict: decision.verdict,
    reason: decision.reason,
    threadKey: decision.threadKey,
    triggerId: decision.triggerId,
    evalId: decision.evalId,
  }
  if (decision.wouldAccept) entry.wouldAccept = decision.wouldAccept
  if (decision.ticketId) entry.ticketId = decision.ticketId
  return entry
}

/** Append-only JSONL writer for decision records. */
export class DecisionLog {
  /** Absolute path of the file this log appends to. */
  readonly path: string
  private readonly now: () => Date
  private readonly onError: ((error: Error, entry: DecisionLogEntry) => void) | undefined
  private written = 0
  private failed = 0

  constructor(options: DecisionLogOptions) {
    this.path = resolveDecisionLogPath(options.path, options.cwd)
    this.now = options.now ?? (() => new Date())
    this.onError = options.onError
  }

  /**
   * Appends one decision as one line.
   *
   * Creates the parent directory when it is missing. Returns a result instead of throwing: the
   * patrol must survive a full disk or a bad path, but the caller still learns that the history
   * has a hole.
   */
  append(decision: DecisionRecord): AppendResult {
    const entry = toDecisionLogEntry(decision, this.now())
    // JSON.stringify escapes newlines inside strings, so one record is always exactly one line.
    const line = `${JSON.stringify(entry)}\n`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, line, { encoding: 'utf8' })
      this.written += 1
      return { ok: true, path: this.path, bytes: Buffer.byteLength(line, 'utf8') }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.failed += 1
      this.onError?.(error, entry)
      return { ok: false, path: this.path, error }
    }
  }

  /** How many records this instance wrote and how many it failed to write. */
  stats(): { path: string; written: number; failed: number } {
    return { path: this.path, written: this.written, failed: this.failed }
  }
}
