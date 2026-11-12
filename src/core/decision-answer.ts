/**
 * The model's answer to `prompts/decide-next-action.md`, read as a format — nothing more.
 *
 * The prompt asks for three lines and an optional fourth:
 *
 *   动作: <one imperative sentence>
 *   理由: <one short sentence>
 *   人工介入: 是 | 否
 *   沉淀: - <practice> — <command>          (optional)
 *
 * Those four labels are the whole interface between a model and the rest of the patrol. The model
 * decides *what* to do; this module only decides *whether the answer arrived in the agreed shape*,
 * so that everything downstream can read `action` / `reason` / `needsHuman` without re-parsing prose
 * or guessing. It is deliberately blind to meaning:
 *
 *   - it does not judge whether the action is sensible, safe, or allowed — that is the Gate's job
 *     (`src/core/policy.ts`), and it must never be delegated to a string in a model's answer;
 *   - it does not check the action against the `动作类型` vocabulary. Importing the vocabulary here
 *     would tempt the next change into "reject an answer whose action looks like a release" — a
 *     semantic rule wearing a format check's clothes, which is exactly how a fail-closed Gate grows
 *     a model-shaped hole. The vocabulary stays in `src/core/action-vocabulary.ts` and is enforced
 *     where the kind is written, read and counted;
 *   - it does not measure the reason's length, or require it to be true.
 *
 * What it *does* enforce is that a malformed answer is loud and machine-greppable. Every refusal is
 * a `DecisionParseError` with a stable ASCII code and field id:
 *
 *   | code               | when                                             |
 *   | ------------------ | ------------------------------------------------ |
 *   | `E-MISSING-FIELD`  | one of 动作 / 理由 / 人工介入 never appeared        |
 *   | `E-DUPLICATE-FIELD`| it appeared twice (two answers, no way to pick)   |
 *   | `E-EMPTY-FIELD`    | it appeared with nothing after the colon          |
 *   | `E-BAD-FLAG`       | 人工介入 was neither 是/否 nor yes/no/true/false    |
 *
 * The message is `CODE:field|readable text`. The ASCII half survives a console code page that
 * mangles the Chinese half, so a CI log or a redirect still answers "which field".
 *
 * Noise is not an error. A model that wraps the three lines in a fence, a heading or a paragraph of
 * explanation still gave a usable answer; those lines are recorded in `ignoredLines` so an operator
 * can see what was dropped, and they never become a field. Tolerance stops exactly there: a label
 * has to be one of the four, and `人工介入` has to be one of six spellings — everything else is a
 * refusal rather than a best guess.
 *
 * The module is pure: no IO, no clock, no environment, no model.
 */

/** The ASCII ids the error codes carry. They are part of the contract; do not rename. */
export type DecisionFieldId = 'action' | 'reason' | 'humanFlag'

/** The four labels the prompt defines, in the order the answer should use them. */
const LABELS = ['动作', '理由', '人工介入'] as const

/** The optional fourth line. It carries a practice, not a decision, so it is never required. */
const NOTE_LABEL = '沉淀'

/** `人工介入` values that mean "a person must decide". Compared after trim + lower case. */
const TRUE_FLAGS = ['是', 'yes', 'true']

/** …and the ones that mean "go ahead without me". */
const FALSE_FLAGS = ['否', 'no', 'false']

/** One answer, in the shape every caller downstream reads. */
export interface DecisionAnswer {
  /** 动作 — the one thing this round should do. */
  action: string
  /** 理由 — why, in the model's own words. */
  reason: string
  /** 人工介入 — `true` for 是, `false` for 否. */
  needsHuman: boolean
  /** 沉淀 — the optional reusable practice line, verbatim; `null` when the model omitted it. */
  skillNote: string | null
  /** Non-empty lines that were not one of the four labels, in the order they appeared. */
  ignoredLines: string[]
}

/**
 * A malformed answer, as opposed to an unreadable file (that is the caller's IO failure).
 *
 * `message` is always `CODE:field|text`, so `stderr` is greppable even when the host code page
 * replaces the Chinese with `?`.
 */
export class DecisionParseError extends Error {
  /** `E-MISSING-FIELD`, `E-DUPLICATE-FIELD`, `E-EMPTY-FIELD`, `E-BAD-FLAG`. */
  readonly code: string
  /** `action`, `reason` or `humanFlag`. */
  readonly field: DecisionFieldId

  constructor(code: string, field: DecisionFieldId, detail: string) {
    super(`${code}:${field}|${detail}`)
    this.name = 'DecisionParseError'
    this.code = code
    this.field = field
  }
}

/** The label → ASCII id map, written once so the three checks cannot disagree about a name. */
function fieldIdOf(label: string): DecisionFieldId | undefined {
  if (label === '动作') return 'action'
  if (label === '理由') return 'reason'
  if (label === '人工介入') return 'humanFlag'
  return undefined
}

/** The Chinese name for an id, for the readable half of an error message. */
function labelOf(id: DecisionFieldId): string {
  if (id === 'action') return '动作'
  if (id === 'reason') return '理由'
  return '人工介入'
}

/** A UTF-8 BOM is invisible in an editor and would become part of the first label. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * `动作:`, `理由:`, `人工介入:`, `沉淀:` — either colon, optional space after it.
 *
 * Anchored, because a label in the middle of a sentence ("我认为动作: 应该是…") is prose, not a field.
 */
const LABEL_RE = /^(?<label>动作|理由|人工介入|沉淀)\s*[:：]\s*(?<value>.*)$/u

/** `- `, `* `, `+ `, `> `, `1. `, `1) ` — markdown decoration a model adds around a list item. */
const DECORATION_RE = /^(?:[-*+>]\s*|\d+[.)]\s*)/

/**
 * Parses one answer.
 *
 * Throws `DecisionParseError` on a missing, duplicated, empty or unreadable required field; returns
 * the answer otherwise. Every other non-empty line is noise and goes to `ignoredLines`.
 */
export function parseDecisionAnswer(text: string): DecisionAnswer {
  const values: Record<DecisionFieldId, string | undefined> = {
    action: undefined,
    reason: undefined,
    humanFlag: undefined,
  }
  const ignoredLines: string[] = []
  let skillNote: string | null = null

  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    // A fence is decoration, never a field: it is recorded and skipped whole, so the three lines
    // inside a ```text block are still read normally on their own turns.
    if (line.startsWith('```')) {
      ignoredLines.push(line)
      continue
    }
    // The label is read through the decoration, and `**` is dropped from the line so a model that
    // bolds a label or a value still produces the value instead of `**值**`.
    const clean = line.replace(DECORATION_RE, '').replaceAll('**', '').trim()
    const match = LABEL_RE.exec(clean)
    if (!match?.groups) {
      ignoredLines.push(line)
      continue
    }
    const value = (match.groups['value'] ?? '').trim()

    if (match.groups['label'] === NOTE_LABEL) {
      // One practice per round. A second 沉淀 line is dropped rather than concatenated: two notes
      // are ambiguous ("which command do I run?"), and the drop is visible in `ignoredLines`.
      if (skillNote === null && value !== '') skillNote = value
      else ignoredLines.push(line)
      continue
    }

    const id = fieldIdOf(match.groups['label'] ?? '')
    if (id === undefined) {
      ignoredLines.push(line)
      continue
    }
    if (values[id] !== undefined) {
      throw new DecisionParseError('E-DUPLICATE-FIELD', id, `重复字段 ${labelOf(id)}`)
    }
    if (value === '') {
      throw new DecisionParseError('E-EMPTY-FIELD', id, `字段为空 ${labelOf(id)}`)
    }
    values[id] = value
  }

  // Missing is checked after the scan and in the prompt's own order, so the first refusal a caller
  // sees is the first line the prompt asks for — not whichever line happened to be scanned first.
  for (const label of LABELS) {
    const id = fieldIdOf(label) as DecisionFieldId
    if (values[id] === undefined) {
      throw new DecisionParseError('E-MISSING-FIELD', id, `缺字段 ${label}`)
    }
  }

  const flag = (values.humanFlag as string).trim().toLowerCase()
  let needsHuman: boolean
  if (TRUE_FLAGS.includes(flag)) needsHuman = true
  else if (FALSE_FLAGS.includes(flag)) needsHuman = false
  else {
    // `是 ｜ 否` (the template itself) lands here on purpose: an answer that did not pick a side is
    // not a decision, and treating it as 否 would silently spend a human's authority.
    throw new DecisionParseError('E-BAD-FLAG', 'humanFlag', `人工介入 只接受 是/否，收到 ${values.humanFlag as string}`)
  }

  return {
    action: values.action as string,
    reason: values.reason as string,
    needsHuman,
    skillNote,
    ignoredLines,
  }
}
