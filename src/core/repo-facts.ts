/**
 * Repo existence as a structured fact.
 *
 * Policy v4's `auto` path needs one fact the direction table never gave it: does `仓库路径` name a
 * real local directory? The cell is free text — a plain path, a path with a note glued to it, two
 * repos added together, a URL marked 未克隆, a markdown file, a relative path, an empty cell — so
 * the question is not "does this string exist on disk". It is "what, if anything, does this cell
 * denote, and can that be proved".
 *
 * The rule is fail-closed: anything this module cannot resolve to exactly one reachable local
 * directory is refused, with a reason, and never guessed. `docs/policy-v4-triage.md` §5 counted 18
 * of 68 cells that no plain `exists()` probe could read; this module is where each of those shapes
 * gets a name instead of a silent `false`.
 *
 * Parsing is pure and the filesystem call is an injectable probe, so the Windows cell shapes can be
 * tested on a Linux runner without a fixture tree, and the default probe stays one `statSync`.
 */
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** What a probe found at one absolute path. */
export type RepoProbeKind = 'directory' | 'file' | 'other' | 'missing' | 'error'
export interface RepoProbeResult {
  kind: RepoProbeKind
  /** errno code when `kind` is `error`, e.g. `EPERM` for a disconnected drive. */
  code?: string
}
/** One filesystem look-up. Tests inject this; production uses `probePath`. */
export type RepoProbe = (resolvedPath: string) => RepoProbeResult

/**
 * What the cell turned out to be.
 *
 * `directory` is the only kind the Gate admits; every other kind is a refusal with its own reason,
 * so "why is this row not autonomous" is answerable from the decision log alone.
 */
export type RepoKind =
  | 'directory'
  | 'file'
  | 'other'
  | 'missing'
  | 'unreachable'
  | 'empty'
  | 'multiple'
  | 'url'
  | 'unresolved'

/** The refusal reason the Gate reports. `repo-exists-ok` is the only passing value. */
export type RepoExistsReason =
  | 'repo-exists-ok'
  | 'repo-empty-cell'
  | 'repo-missing'
  | 'repo-not-a-directory'
  | 'repo-path-unreachable'
  | 'repo-path-ambiguous'
  | 'repo-path-relative-unresolved'
  | 'repo-not-local-path'
  | 'repo-not-cloned'

/** One path-shaped part of a cell, with what was found there. */
export interface RepoCandidate {
  /** Absolute normalised path, or the raw relative text when it could not be resolved. */
  path: string
  kind: RepoKind
  exists: boolean
  /** Text that followed the path inside the same cell segment, e.g. `（DSH 本体未克隆…）`. */
  annotation?: string
}

/**
 * The fact the Gate reads.
 *
 * `exists` is per path: true when the single candidate is present on disk in any form (a file
 * counts — `kind` says so, and `repo-not-a-directory` is still a refusal). `kind`/`reason` are per
 * cell: a cell that denotes two repos, or a path plus prose, has no single path, so it reports
 * `exists: false` with `repo-path-ambiguous` and keeps the per-candidate truth in `candidates`.
 */
export interface RepoExistsFact {
  /** The cell exactly as the table wrote it, arrays joined by newlines. */
  raw: string
  exists: boolean
  kind: RepoKind
  /** Absolute, normalised path; `''` when the cell denotes no single local path. */
  normalizedPath: string
  reason: RepoExistsReason
  candidates: RepoCandidate[]
}

export interface RepoInspectOptions {
  /**
   * Directory a relative cell resolves against. Omitted means "unresolvable": the direction table
   * has no notion of a working directory, so a relative path cannot be guessed into one.
   */
  baseDir?: string
  /** Filesystem look-up. Defaults to `statSync`. */
  probe?: RepoProbe
}

/** The default probe: one `statSync`, with "not there" and "cannot look" kept apart. */
export function probePath(resolvedPath: string): RepoProbeResult {
  try {
    const stat = statSync(resolvedPath, { throwIfNoEntry: false })
    if (!stat) return { kind: 'missing' }
    if (stat.isDirectory()) return { kind: 'directory' }
    if (stat.isFile()) return { kind: 'file' }
    return { kind: 'other' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A path that cannot be walked to is not a path that is absent; a missing drive letter is.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'error', code }
  }
}

/** Characters that start prose rather than continue a path. `:` is handled separately. */
const ANNOTATION_MARKERS = ['（', '(', '【', '[', '<', '>', '"', '|', '*', '?', '：', '。', '，', ',']
const CLONE_MARK = /^[（(]?\s*未克隆\s*[）)]?\s*[:：]?\s*/
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/

/** A cell may be an array of Bitable segments; each becomes its own line. */
function normalizeCell(raw: unknown): string {
  const textOf = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value) ?? ''
  }
  const text = Array.isArray(raw) ? raw.map(textOf).join('\n') : textOf(raw)
  return text.replace(/^\uFEFF/, '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim()
}

/**
 * Splits a cell into path segments.
 *
 * Line breaks, `;`/`；`/`、` and a spaced ` + ` are the separators the table actually uses for
 * "more than one repo" (`E:\repos\gitAll\mpd + E:\repos\gitAll\mpd-front`). They only count at
 * bracket depth 0: a note in parentheses may contain any of them (`（DSH 本体未克隆；上游 …）`), and
 * splitting inside it turns one annotated path into two bogus candidates. Commas are *not*
 * separators: they appear inside prose far more often than between paths, so a comma-separated
 * cell stays one segment and is refused as ambiguous rather than split on a guess.
 */
function splitSegments(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  const flush = (): void => { parts.push(current); current = '' }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (char === '（' || char === '(' || char === '【' || char === '[') depth += 1
    else if (char === '）' || char === ')' || char === '】' || char === ']') depth = Math.max(0, depth - 1)
    if (depth === 0) {
      if (char === ';' || char === '；' || char === '、' || char === '\n') { flush(); continue }
      if (char === '+' && /\s/.test(text[index - 1] ?? '') && /\s/.test(text[index + 1] ?? '')) { flush(); continue }
    }
    current += char
  }
  flush()
  return parts
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, '').trim())
    .filter((part) => part !== '')
}

/** Where the path ends and the note starts, or -1 when the segment is all path. */
function annotationStart(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    // `D:` at offset 1 is the drive, not prose.
    if (char === ':') {
      if (index === 1 && /[A-Za-z]/.test(text[0] ?? '')) continue
      return index
    }
    if (ANNOTATION_MARKERS.includes(char)) return index
  }
  return -1
}

interface Segment {
  pathText: string
  annotation: string
  notCloned: boolean
  url: boolean
}

function classifySegment(segment: string): Segment {
  let text = segment.trim()
  let notCloned = false
  const cloneMark = CLONE_MARK.exec(text)
  if (cloneMark) {
    notCloned = true
    text = text.slice(cloneMark[0].length).trim()
  }
  if (URL_RE.test(text)) return { pathText: '', annotation: '', notCloned, url: true }
  const start = annotationStart(text)
  const pathText = (start < 0 ? text : text.slice(0, start)).trim()
  const annotation = start < 0 ? '' : text.slice(start).trim()
  return { pathText, annotation, notCloned, url: false }
}

/** `win32` for drive/UNC shapes regardless of host, `posix` otherwise. */
function isWindowsPath(text: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(text) || text.startsWith('\\\\')
}

function tidy(path: string, windows: boolean): string {
  const api = windows ? win32 : posix
  let resolved = api.normalize(path)
  if (windows) resolved = resolved.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`)
  const isRoot = /^[A-Za-z]:\\$/.test(resolved) || resolved === '/' || resolved === '\\'
  if (!isRoot) resolved = resolved.replace(/[\\/]+$/, '')
  return resolved
}

interface Resolved {
  path: string
  unresolved: boolean
}

/**
 * Absolute path for a segment, or `unresolved` when it is relative and no base was given.
 *
 * A relative cell is not promoted to "probably the patrol's cwd": the direction table is read by a
 * host process whose cwd has nothing to do with the row's project, so guessing would turn
 * `02_部署运维/ccx配置与排查指南.md` into a directory that merely happens to exist.
 */
function resolvePath(pathText: string, baseDir?: string): Resolved {
  if (isWindowsPath(pathText) || pathText.startsWith('/')) {
    return { path: tidy(pathText, isWindowsPath(pathText)), unresolved: false }
  }
  if (!baseDir) return { path: '', unresolved: true }
  const windows = isWindowsPath(baseDir) || /^[A-Za-z]:/.test(baseDir)
  const api = windows ? win32 : posix
  return { path: tidy(api.resolve(baseDir, pathText), windows), unresolved: false }
}

function kindOf(probe: RepoProbeResult): RepoKind {
  switch (probe.kind) {
    case 'directory': return 'directory'
    case 'file': return 'file'
    case 'other': return 'other'
    case 'missing': return 'missing'
    default: return 'unreachable'
  }
}

function reasonOf(kind: RepoKind): RepoExistsReason {
  switch (kind) {
    case 'directory': return 'repo-exists-ok'
    case 'missing': return 'repo-missing'
    case 'unreachable': return 'repo-path-unreachable'
    case 'unresolved': return 'repo-path-relative-unresolved'
    case 'url': return 'repo-not-local-path'
    default: return 'repo-not-a-directory'
  }
}

/**
 * Reads one `仓库路径` cell and says what it denotes.
 *
 * Every branch either proves "one local directory, and here it is" or names why it could not:
 * `repo-empty-cell`, `repo-not-cloned`, `repo-not-local-path`, `repo-path-relative-unresolved`,
 * `repo-path-ambiguous`, `repo-missing`, `repo-path-unreachable`, `repo-not-a-directory`.
 */
export function inspectRepoPath(raw: unknown, options: RepoInspectOptions = {}): RepoExistsFact {
  const probe = options.probe ?? probePath
  const rawText = normalizeCell(raw)
  const refuse = (reason: RepoExistsReason, kind: RepoKind, candidates: RepoCandidate[] = []): RepoExistsFact => ({
    raw: rawText,
    exists: false,
    kind,
    normalizedPath: '',
    reason,
    candidates,
  })

  if (rawText === '') return refuse('repo-empty-cell', 'empty')
  const segments = splitSegments(rawText)
  if (segments.length === 0) return refuse('repo-empty-cell', 'empty')

  const candidates: RepoCandidate[] = []
  let sawNotCloned = false
  let sawUrl = false
  let sawUnresolved = false
  let sawProseOnly = false

  for (const segment of segments) {
    const parsed = classifySegment(segment)
    if (parsed.notCloned) { sawNotCloned = true; continue }
    if (parsed.url) { sawUrl = true; continue }
    if (parsed.pathText === '') { sawProseOnly = true; continue }
    const resolved = resolvePath(parsed.pathText, options.baseDir)
    if (resolved.unresolved) {
      sawUnresolved = true
      candidates.push({ path: parsed.pathText, kind: 'unresolved', exists: false, annotation: parsed.annotation || undefined })
      continue
    }
    const kind = kindOf(probe(resolved.path))
    candidates.push({
      path: resolved.path,
      kind,
      exists: kind === 'directory' || kind === 'file' || kind === 'other',
      annotation: parsed.annotation || undefined,
    })
  }

  // One path per distinct location: `D:\x` written twice is still one repo, not an ambiguity.
  const unique: RepoCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }

  if (unique.length === 0) {
    if (sawNotCloned) return refuse('repo-not-cloned', 'url')
    if (sawUrl) return refuse('repo-not-local-path', 'url')
    if (sawUnresolved) return refuse('repo-path-relative-unresolved', 'unresolved')
    return refuse('repo-path-ambiguous', 'multiple', sawProseOnly ? [] : candidates)
  }

  if (unique.length > 1) return refuse('repo-path-ambiguous', 'multiple', unique)

  const only = unique[0]
  if (!only) return refuse('repo-path-ambiguous', 'multiple', [])
  if (only.kind === 'unresolved') return refuse('repo-path-relative-unresolved', 'unresolved', unique)

  // Everything that reached here is one path; the cell is still refused when the same segment
  // carried a note, or a second segment was a URL / a 未克隆 marker: the row's repo is not in doubt
  // about *existence*, it is in doubt about *which* statement it makes.
  const ambiguous = Boolean(only.annotation) || sawUrl || sawNotCloned || sawUnresolved
  return {
    raw: rawText,
    exists: only.exists,
    kind: only.kind,
    normalizedPath: only.path,
    reason: ambiguous ? 'repo-path-ambiguous' : reasonOf(only.kind),
    candidates: unique,
  }
}
