/**
 * The action-type vocabulary: one list, one reading rule, one set of counts.
 *
 * The direction table's structured `动作类型` column has nine allowed values, and they are written
 * down exactly once — here. Everything that reads, counts or writes that column goes through this
 * module, so a tenth spelling cannot appear in one path while the other eight paths still believe
 * there are nine:
 *
 *   - `src/core/action-facts.ts` classifies a row against `ACTION_KINDS` and re-exports the list;
 *   - `scripts/policy-triage-check.mjs` groups a table dump by the same list, so the published
 *     counts cannot drift from the classifier that produced them;
 *   - the write-back path (`patrol report --action-type`) can only write a canonical spelling;
 *   - `scripts/release-check.mjs` runs `verifyActionVocabulary()`, so breaking an invariant here
 *     fails the release check instead of the first row that happens to hit it.
 *
 * A cell has exactly four states, and each one has one deterministic outcome:
 *
 *   | state        | what the cell holds                       | what happens                        |
 *   | ------------ | ----------------------------------------- | ----------------------------------- |
 *   | `valid`      | a canonical spelling, as written          | that kind                           |
 *   | `normalized` | a variant recoverable by trim/case fold   | that kind, and the row is counted   |
 *   | `missing`    | no column, a blank cell, or blank space   | no structured answer (its own tally) |
 *   | `invalid`    | anything else (`auto`, `待定`, a typo)    | recorded as `unclear`, counted as   |
 *   |              |                                           | `invalid_action`, never guessed at  |
 *
 * "Recoverable" is deliberately narrow: trimming surrounding whitespace and folding case. It is
 * the only tolerance a person typing a cell gets. `repo code`, `repo_code` and `repo-code!` are
 * not variants of `repo-code`; they are typos, and a typo must stop the row rather than be re-read
 * as repo work by the word list.
 *
 * The module is pure: no IO, no clock, no environment.
 */

/**
 * Every value the `动作类型` column may hold, in the order the table offers them.
 *
 * This is the single source of truth. Add a kind here and the compiler points at the places that
 * must decide what it means (`actionRefusal()` in `action-facts.ts` is keyed by this type).
 */
export const ACTION_KINDS = [
  'repo-code',
  'repo-test',
  'repo-doc',
  'field-ops',
  'release',
  'secret',
  'config',
  'decision',
  'unclear',
] as const

/** What kind of work a row's action asks for. */
export type ActionKind = (typeof ACTION_KINDS)[number]

/**
 * The statistics bucket for a row whose cell holds no value at all.
 *
 * Kept beside the kinds on purpose: a report that only counts the nine makes "the column is not
 * filled yet" look like "the column is filled and clean". Missing is its own row in the tally.
 */
export const ACTION_MISSING = 'missing'

/** A kind, or the `missing` bucket. Never a guess. */
export type ActionBucket = ActionKind | typeof ACTION_MISSING

/** The four states a `动作类型` cell can be in. */
export type ActionCellState = 'valid' | 'normalized' | 'invalid' | 'missing'

/** One reading of one cell: what it said, what it means, and which of the four states it is. */
export interface ActionCellReading {
  state: ActionCellState
  /** The cell as it arrived, untrimmed; `''` when the column is absent. */
  raw: string
  /** `raw` after the only normalisation this module allows: trim + case fold. */
  value: string
  /** The kind, when the cell is usable. Absent for `missing` and `invalid`. */
  kind?: ActionKind
}

/**
 * Reads one cell into one of the four states.
 *
 * This is the only place the nine values are compared against a cell. `undefined` and `null` are
 * `missing` (no column), a blank or whitespace-only string is `missing` (an empty cell) — they are
 * the same answer to "what did the table say", so they are the same state. Anything non-empty that
 * survives trim + case fold but is not in `ACTION_KINDS` is `invalid`.
 */
export function readActionCell(value: string | null | undefined): ActionCellReading {
  const raw = value ?? ''
  const folded = raw.trim().toLowerCase()
  if (folded === '') return { state: 'missing', raw, value: '' }
  const kind = (ACTION_KINDS as readonly string[]).includes(folded) ? (folded as ActionKind) : undefined
  if (kind === undefined) return { state: 'invalid', raw, value: folded }
  // A cell that was already canonical is `valid`; one that needed trimming or case folding is
  // `normalized`. The row still gets the kind either way, but the tally keeps the difference.
  return { state: raw === kind ? 'valid' : 'normalized', raw, value: kind, kind }
}

/** The kind a value names, or `undefined` when it names none. */
export function normalizeActionKind(value: string | null | undefined): ActionKind | undefined {
  return readActionCell(value).kind
}

/**
 * The canonical spelling to write into the cell, or a throw.
 *
 * The write-back path uses this instead of passing a caller's string through: writing `Repo-Code`
 * into a single-select column would either fail at the API or create a tenth option. The error
 * names the allowed set, so the caller can fix the flag instead of guessing.
 */
export function writeActionCell(value: string | null | undefined): ActionKind {
  const reading = readActionCell(value)
  if (reading.kind === undefined) {
    throw new Error(`动作类型「${reading.raw.trim() || '(空)'}」不在词表内（${ACTION_KINDS.join(' / ')}）`)
  }
  return reading.kind
}

/** Everything a report needs to say about the column, one row per state. */
export interface ActionCellCounts {
  /** Rows looked at. Equals `valid + normalized + missing + invalidAction`. */
  total: number
  /** Rows whose cell held a canonical spelling exactly as written. */
  valid: number
  /** Rows rescued by trim/case fold. Counted under their kind as well. */
  normalized: number
  /** Rows with no structured value at all — the separate bucket, not a kind. */
  missing: number
  /** Rows whose non-empty value is outside the vocabulary. Recorded as `unclear`. */
  invalidAction: number
  /**
   * Per-kind counts. `unclear` includes the rows down-graded from `invalid_action`, because that
   * is what they are recorded as; `missing` rows are *not* in here (they have their own bucket).
   */
  byKind: Record<ActionKind, number>
}

/** `{ repo-code: 0, … }` — every kind present, so a report never shows an accidental hole. */
function emptyKindCounts(): Record<ActionKind, number> {
  const counts = {} as Record<ActionKind, number>
  for (const kind of ACTION_KINDS) counts[kind] = 0
  return counts
}

/**
 * Groups a column's cells by the nine kinds, with the unreadable and the unwritten kept apart.
 *
 * Two rules make the tally checkable rather than decorative:
 *   - an `invalid` cell is counted where it is *recorded* (`byKind.unclear`) **and** in
 *     `invalidAction`, so the published number names the problem instead of hiding inside `unclear`;
 *   - a `missing` cell is only in `missing`, never in `byKind`, so the four states add up to
 *     `total` and `byKind` adds up to `total - missing`.
 */
export function countActionCells(values: Iterable<string | null | undefined>): ActionCellCounts {
  const counts: ActionCellCounts = {
    total: 0,
    valid: 0,
    normalized: 0,
    missing: 0,
    invalidAction: 0,
    byKind: emptyKindCounts(),
  }
  for (const value of values) {
    counts.total += 1
    const reading = readActionCell(value)
    switch (reading.state) {
      case 'missing':
        counts.missing += 1
        break
      case 'invalid':
        counts.invalidAction += 1
        counts.byKind.unclear += 1
        break
      case 'normalized':
        counts.normalized += 1
        counts.byKind[reading.kind as ActionKind] += 1
        break
      case 'valid':
        counts.valid += 1
        counts.byKind[reading.kind as ActionKind] += 1
        break
    }
  }
  return counts
}

/** `repo-code 10 · … · unclear 18` — the grouped line a report shows; kinds with no rows are left out. */
export function describeActionKinds(counts: ActionCellCounts): string {
  const parts = ACTION_KINDS
    .filter((kind) => counts.byKind[kind] > 0)
    .map((kind) => `${kind} ${counts.byKind[kind]}`)
  return parts.length > 0 ? parts.join(' · ') : '(none)'
}

/** `valid 74 · normalized 4 · missing 0 · invalid_action 0` — the four states, named. */
export function describeActionCells(counts: ActionCellCounts): string {
  return `valid ${counts.valid} · normalized ${counts.normalized} · ${ACTION_MISSING} ${counts.missing} · invalid_action ${counts.invalidAction}`
}

/**
 * The vocabulary's own invariants, as a list of violations (empty means the list is sound).
 *
 * Neither a report nor a unit test is the right owner of "the list is still the list": a report
 * only checks the rows it happens to see, and a unit test only runs where vitest runs. This
 * function is the one place the properties are written, and `scripts/release-check.mjs` calls it
 * on every candidate tarball — a tenth kind, a duplicate, a spelling that no longer reads back as
 * itself, or a tally that does not add up fails the release instead of a row.
 */
export function verifyActionVocabulary(): string[] {
  const problems: string[] = []
  if (ACTION_KINDS.length !== 9) problems.push(`expected 9 kinds, found ${ACTION_KINDS.length}`)

  const seen = new Set<string>()
  for (const kind of ACTION_KINDS) {
    if (seen.has(kind)) problems.push(`duplicate kind ${kind}`)
    seen.add(kind)
    if (kind !== kind.trim().toLowerCase()) problems.push(`kind ${kind} is not lowercase and trimmed`)
    const reading = readActionCell(kind)
    if (reading.state !== 'valid' || reading.kind !== kind) {
      problems.push(`canonical spelling ${kind} reads back as ${reading.state}/${reading.kind ?? '(none)'}`)
    }
    try {
      if (writeActionCell(kind) !== kind) problems.push(`writeActionCell(${kind}) does not return the canonical spelling`)
    } catch (error) {
      problems.push(`writeActionCell(${kind}) threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // A value outside the set must be `invalid`, not quietly folded into a kind: build the outsider
  // from the list itself so this check keeps working when the list changes.
  const outsider = `${ACTION_KINDS[0]}-typo`
  if (readActionCell(outsider).state !== 'invalid' || readActionCell(outsider).kind !== undefined) {
    problems.push(`an unlisted value (${outsider}) is not reported as invalid`)
  }
  try {
    writeActionCell(outsider)
    problems.push(`writeActionCell() accepted an unlisted value (${outsider})`)
  } catch {
    // Expected: the write path refuses what the list does not name.
  }
  for (const blank of ['', '   ', undefined, null]) {
    if (readActionCell(blank).state !== 'missing') problems.push(`a blank cell (${JSON.stringify(blank)}) is not reported as missing`)
  }

  // The tally has to add up on a sample built from the list, or every published count is suspect.
  const sample: (string | undefined)[] = [...ACTION_KINDS, outsider, '', undefined]
  const counts = countActionCells(sample)
  const states = counts.valid + counts.normalized + counts.missing + counts.invalidAction
  if (counts.total !== states) problems.push(`counts do not add up: total ${counts.total}, states ${states}`)
  const kinds = ACTION_KINDS.reduce((sum, kind) => sum + counts.byKind[kind], 0)
  if (kinds !== counts.total - counts.missing) {
    problems.push(`per-kind counts do not add up: kinds ${kinds}, total - missing ${counts.total - counts.missing}`)
  }
  if (counts.invalidAction !== 1 || counts.byKind.unclear !== 2) {
    problems.push(`invalid_action is not counted once and in unclear: invalid ${counts.invalidAction}, unclear ${counts.byKind.unclear}`)
  }
  if (counts.missing !== 2) problems.push(`blank cells are not counted as missing: ${counts.missing}`)

  return problems
}
