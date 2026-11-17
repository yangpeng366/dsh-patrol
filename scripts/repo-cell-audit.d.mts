/**
 * Types for `scripts/repo-cell-audit.mjs`, so the vitest spec can import the exported functions
 * under `strict` without an implicit-any. The runtime is JavaScript: the guard that matters is the
 * runtime one (`auditCells` refuses to run without the Gate's `inspectRepoPath()`), and typing
 * `inspect` as optional here keeps the declaration honest about that. The inspector's own types are
 * imported from the Gate module rather than restated, so an audit cannot drift from the Gate.
 */
import type { RepoExistsFact, RepoInspectOptions } from '../src/core/repo-facts.ts'

export interface RepoCandidate {
  path: string
  kind: string
  exists: boolean
  annotation?: string
  label?: string
}

export interface RepoCellOffender {
  recordId: string
  name: string
  raw: string
  reason: string
  kind: string
  candidates: RepoCandidate[]
}

export interface RepoCellTally {
  reason: string
  count: number
}

export interface RepoCellReport {
  total: number
  pure: number
  normalized: number
  offenders: RepoCellOffender[]
  tally: RepoCellTally[]
}

export interface RepoCellAuditOptions {
  /** The Gate's `inspectRepoPath()`; required at runtime. */
  inspect?: (raw: unknown, options?: RepoInspectOptions) => RepoExistsFact
  /** Filesystem look-up forwarded to `inspectRepoPath()`; tests inject a fake one. */
  probe?: RepoInspectOptions['probe']
}

export interface RepoCellAuditArgs {
  file?: string
  json: boolean
  strict: boolean
  help?: boolean
}

export function cellText(value: unknown): string
export function newestDump(dir?: string): string | undefined
export function parseDump(text: string): Record<string, unknown>[]
export function auditCells(rows: Record<string, unknown>[], options: RepoCellAuditOptions): RepoCellReport
export function renderReport(report: RepoCellReport, source: string): string
export function exitCodeFor(report: RepoCellReport, strict: boolean): number
export function parseArgs(argv: string[]): RepoCellAuditArgs
