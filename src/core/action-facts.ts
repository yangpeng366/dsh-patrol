/**
 * Action type as a structured fact.
 *
 * Policy v4's `auto` path has to answer a second question the direction table never answers in a
 * column: *what kind of work is `下一步`?* A row can name an existing local repo and still be
 * impossible for an unattended round — it asks for 现场 work, a release, a secret, a Bitable/config
 * change, or a human decision. Sending those to an Assessment burns budget and can cross an
 * authorization boundary the row never granted.
 *
 * There are two ways to answer, and this module keeps them apart:
 *
 *   1. the table's structured `动作类型` column, when the row has one. The value is the fact — this
 *      module trims it, ignores case, checks it against the kind set and takes it as `kind`, with
 *      `source: 'column'`. It wins over the word list even when the prose says something else.
 *   2. otherwise the row's *existing* cells (`下一步` / `简要描述` / `用户批注` / `授权边界` /
 *      `贡献类型` / `审批状态`), read with a word list, `source: 'text'`.
 *
 * The first path exists because the word list is a reading of prose, and prose can say "这步要发版"
 * in a way no list catches. The second path is what runs before the column is filled, and it is the
 * prefill tool for it. When a column value is present but not a kind at all (`auto`, `待定`), the
 * row is `unclear` and the reason names the bad value: an unreadable cell must not be silently
 * re-read as repo work, and reading it as "no column" would hide the typo.
 *
 * The module is pure: no IO, no filesystem, no model.
 *
 * Fail-closed is the whole point, so the text rules are deliberately asymmetric:
 *   - **Admission needs the action fields.** `repo-code` / `repo-test` / `repo-doc` are only read
 *     from `下一步` and `简要描述`. A mention of "代码" in `用户批注` (a history log) can never
 *     admit a row.
 *   - **Refusal may come from any field.** A secret, site visit, release, config change or pending
 *     decision mentioned anywhere is enough to refuse.
 *   - **The most restrictive kind wins.** Precedence runs secret → field-ops → config → release →
 *     decision → repo-code → repo-test → repo-doc, so a sentence that says "代码已就位，等用户
 *     拍板" is `decision`, never `repo-code`.
 *   - **No evidence is `unclear`, never `repo-code`.** Observation-only lines ("复核完成…无漂移"),
 *     English boilerplate ("Review the saved Codex output…") and empty cells all land here with a
 *     reason that names what is missing.
 *
 * `docs/policy-v4-triage.md` §6.2 carries the word list and the measured counts; the nine spellings
 * themselves live in `action-vocabulary.ts`, and this file is the only place the word list is
 * executed.
 */

import { ACTION_KINDS, normalizeActionKind, readActionCell, type ActionKind } from './action-vocabulary.ts'

/**
 * Every kind a row's action can have, spelled exactly as the structured `动作类型` column spells it.
 *
 * The list itself lives in `action-vocabulary.ts` and is re-exported here for the callers that grew
 * up importing it from this module. There is one copy: a spelling added there is a kind here, and a
 * value outside it is not a kind whatever it looks like.
 */
export { ACTION_KINDS }
export type { ActionKind }

/**
 * Where `kind` came from.
 *
 * `column` means the direction table's `动作类型` cell said it: a person wrote it down, and the word
 * list does not get a vote. `text` means this module inferred it from prose — the column is absent,
 * blank, or unreadable, and the reason says which. The decision log carries this marker per row, so
 * "was this written or guessed" is answerable from the log.
 */
export type ActionSource = 'column' | 'text'

/** The row cell an evidence fragment came from, spelled as the table spells it. */
export type ActionField = '动作类型' | '下一步' | '简要描述' | '用户批注' | '授权边界' | '贡献类型' | '审批状态'

/** The refusal code the Gate reports for a non-repo action. */
export type ActionRefusal =
  | 'action-field-ops'
  | 'action-release'
  | 'action-needs-secret'
  | 'action-needs-config'
  | 'action-needs-decision'
  | 'action-unclear'

/**
 * The cells this module reads. Every field is optional so the caller can leave a column out; an
 * omitted field is "no evidence", which is the fail-closed direction for admission.
 */
export interface ActionInput {
  /**
   * `动作类型` — the structured column, when the table has one. A valid value *is* the fact; an
   * empty cell or a missing column means "no structured answer", never "no action".
   */
  actionType?: string
  /** `下一步` — the row's own action line. The primary evidence. */
  nextStep?: string
  /** `简要描述` — what the row is about. Secondary evidence. */
  description?: string
  /** `用户批注` — free-form history; refusal-only evidence. */
  userNote?: string
  /** `授权边界` — `自主` / `需审批` / `只读`. */
  authorization?: string
  /** `贡献类型` — `功能增强` / `研究探索` / `bug修复` / `测试补充` / `文档完善`. */
  contribution?: string
  /** `审批状态` — `待审` / `已通过` / `已忽略` / `阻塞`. */
  approval?: string
}

/** One kind that matched, with where and what. */
export interface ActionMatch {
  kind: Exclude<ActionKind, 'unclear'>
  field: ActionField
  /** Matched terms, deduplicated, in word-list order. */
  matched: string[]
  /** Sentence fragment around the first match, whitespace collapsed, at most 80 characters. */
  evidence: string
  /** Whether this match came from an action field, i.e. whether it could admit a row. */
  decisive: boolean
}

/** The fact the Gate reads. */
export interface ActionFacts {
  kind: ActionKind
  /** Whether `kind` was written in the `动作类型` column or inferred from prose. */
  source: ActionSource
  /** Matched terms for `kind`; empty when `kind` is `unclear`. */
  matched: string[]
  /** Original fragment for `kind`, at most 80 characters; `''` when `unclear`. */
  evidence: string
  /** Field the evidence came from (`动作类型` for a column value); `''` when `unclear` from text. */
  field: ActionField | ''
  /** Human-readable: why this kind won, or exactly which evidence is missing. */
  reason: string
  /** Every other kind that matched, most restrictive first — the audit trail for the choice. */
  alternatives: ActionMatch[]
}

/**
 * What each cell is allowed to say.
 *
 * `下一步` is the row's action line, and the only cell whose words can admit a row.
 * `简要描述` says what the row is *about*: it is kept in `alternatives` for audit, but it neither
 * admits nor refuses. Topic words in it are architecture, not action — "机构 API Key 存 DB" and
 * "oauth-core 包" are descriptions of a codebase, and reading them as "this step needs a key"
 * refused 7 of 78 rows on a first pass.
 * `用户批注` is a history log, so it is read for one thing only: a *pending* human decision
 * (待拍板 / 等用户 / 待确认). Past-tense decisions in the same cell are exactly why a keyword scan
 * of it would refuse nearly every row.
 * `授权边界` and `审批状态` are structured, and only the decision kind reads them.
 * `贡献类型` never classifies on its own; it only breaks a tie between repo kinds.
 */
const FIELD_ROLES: Readonly<Record<ActionField, { kinds: 'all' | 'decision' | 'none'; decisive: boolean; refusal: boolean }>> = {
  // The structured column is never scanned for words: its value is read as a whole, above.
  动作类型: { kinds: 'none', decisive: false, refusal: false },
  下一步: { kinds: 'all', decisive: true, refusal: true },
  简要描述: { kinds: 'all', decisive: false, refusal: false },
  用户批注: { kinds: 'decision', decisive: false, refusal: true },
  授权边界: { kinds: 'decision', decisive: false, refusal: true },
  贡献类型: { kinds: 'none', decisive: false, refusal: false },
  审批状态: { kinds: 'decision', decisive: false, refusal: true },
}

/** Fields that can admit a row. Everything else can only refuse one. */
const ACTION_FIELDS: readonly ActionField[] = ['下一步']

/**
 * The word list, in precedence order. `secret` first: a row that touches a key is refused even
 * when the same sentence also says 代码, 发布 or 拍板.
 */
const LEXICON: readonly { kind: Exclude<ActionKind, 'unclear'>; terms: readonly string[] }[] = [
  {
    kind: 'secret',
    terms: [
      '密钥', '秘钥', '口令', '密码', '凭据', '凭证', '私钥', '证书', 'SecretId', 'SecretKey',
      'AppSecret', 'AppKey', 'AccessKey', 'access key', 'api key', 'apikey', 'token', 'jwt',
      'AK/SK', '登录态', 'oauth',
    ],
  },
  {
    kind: 'field-ops',
    terms: ['现场', '上门', '机房', '实地', '演示', '办公现场', '客户现场', '内网', '现场环境', '现场侧', '现场账号', '运维窗口'],
  },
  {
    kind: 'config',
    terms: [
      '配置项', '配置文件', 'ConfigMap', 'Bitable', '表字段', '字段维护', '新增字段', '配置管理页',
      'helm values', 'values.yaml', '环境变量', '.env', '白名单', '权限配置', '数据库配置', '改配置',
      '配置 SQL', '站点配置', 'yml',
    ],
  },
  {
    kind: 'release',
    terms: [
      '发版', '发布', '上线', '部署', '打包', 'npm publish', 'npm registry', 'npm 发布', '打 tag',
      'tag 发布', '版本发布', '提测', 'Jenkins', '镜像', '灰度', 'release', 'deploy', '发包',
    ],
  },
  {
    kind: 'decision',
    terms: [
      '拍板', '待定', '待确认', '待授权', '待批准', '待用户', '等用户', '需用户', '请用户',
      '由用户', '待决', '未定', '决策点', '待批', '等你', '批准后', '授权后', '需审批',
      '是否授权', '是否删除', '要不要', '需要你', '需要用户', '请确认', '需确认', '确认后', '待审', '阻塞',
      '用户验收', '待启动',
    ],
  },
  {
    kind: 'repo-code',
    terms: [
      '代码', '实现', '重构', '修复', '编译', '函数', '模块', '提交', 'commit', 'push',
      '分支', '落库', '写回', 'merge', '合并', '改造', '新增文件', '删除文件',
    ],
  },
  {
    kind: 'repo-test',
    terms: ['单测', '单元测试', '测试', '用例', '回归', '覆盖率', 'vitest', 'jest', 'spec', 'e2e', 'test'],
  },
  {
    kind: 'repo-doc',
    terms: ['文档', 'README', 'docs', '注释', 'CHANGELOG', '说明文档', '笔记'],
  },
]

/** `贡献类型` values that name a repo action. Used to break ties between repo kinds only. */
const CONTRIBUTION_KINDS: Readonly<Record<string, Exclude<ActionKind, 'unclear'>>> = {
  功能增强: 'repo-code',
  bug修复: 'repo-code',
  测试补充: 'repo-test',
  文档完善: 'repo-doc',
}

/** The longest evidence fragment this module returns. */
export const MAX_EVIDENCE = 80

const FIELD_VALUES: readonly { field: ActionField; read: (input: ActionInput) => string }[] = [
  { field: '下一步', read: (input) => input.nextStep ?? '' },
  { field: '简要描述', read: (input) => input.description ?? '' },
  { field: '用户批注', read: (input) => input.userNote ?? '' },
  { field: '授权边界', read: (input) => input.authorization ?? '' },
  { field: '贡献类型', read: (input) => input.contribution ?? '' },
  { field: '审批状态', read: (input) => input.approval ?? '' },
]

/** Cells arrive with newlines, tabs and NBSP from Bitable; evidence is one readable line. */
function flatten(text: string): string {
  return text
    .replace(/unexpected token/gi, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

const ASCII_ONLY = /^[\x20-\x7e]+$/
const WORD_CHAR = /[a-z0-9_]/

/**
 * Negation next to a keyword, so "仓库零凭据" and "密码不入文档" are not read as "needs a secret".
 *
 * Two characters on either side covers the shapes the table actually writes (零/无/未/不/勿) and is
 * narrow enough not to swallow a real request ("补回密钥", "提供 SecretId/Key").
 */
const NEGATION_BEFORE = /[零无不未勿免非]/
/** Phrases that negate a few characters later, e.g. "不再修代码" — the verb sits in between. */
const NEGATION_PHRASE = /(?:不再|无需|不用|没有|未再|不予|不得)/
const NEGATION_AFTER = /^(?:不|未|勿|零|无)/
const LEADING_NOISE = /^[\s:：，,、；;。.!！?？]+/

function negated(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 2), at)
  const wider = text.slice(Math.max(0, at - 5), at)
  const after = text.slice(at + length, at + length + 4).replace(LEADING_NOISE, '')
  return NEGATION_BEFORE.test(before) || NEGATION_PHRASE.test(wider) || NEGATION_AFTER.test(after)
}

/**
 * Where `term` occurs in `text`, ignoring case.
 *
 * An ASCII term has to sit on a word boundary, so `pr` does not match inside `process` and
 * `test` does not match inside `latest`. A CJK term has no boundaries to respect.
 */
function occurrences(text: string, term: string): number[] {
  const haystack = text.toLowerCase()
  const needle = term.toLowerCase()
  const ascii = ASCII_ONLY.test(term)
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (ascii) {
      const before = haystack[at - 1] ?? ''
      const after = haystack[at + needle.length] ?? ''
      if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue
    }
    if (negated(text, at, needle.length)) continue
    found.push(at)
  }
  return found
}

/** At most `MAX_EVIDENCE` characters around one match, with `…` where the sentence was cut. */
export function evidenceAt(text: string, index: number, matchLength: number): string {
  if (text.length <= MAX_EVIDENCE) return text
  // Keep the matched word inside the window, and prefer context on both sides.
  let start = Math.max(0, index - Math.floor((MAX_EVIDENCE - matchLength) / 2))
  let end = Math.min(text.length, start + MAX_EVIDENCE)
  start = Math.max(0, end - MAX_EVIDENCE)
  const lead = start > 0 ? 1 : 0
  const tail = end < text.length ? 1 : 0
  const body = text.slice(start, end).slice(0, MAX_EVIDENCE - lead - tail)
  return `${lead ? '…' : ''}${body}${tail ? '…' : ''}`
}

interface Hit {
  kind: Exclude<ActionKind, 'unclear'>
  field: ActionField
  matched: string[]
  evidence: string
  decisive: boolean
  /** Whether this hit may refuse the row. `简要描述` and `贡献类型` may not. */
  refusal: boolean
  order: number
}

/**
 * Reads the row's cells and names one action kind from prose alone.
 *
 * Every branch either names a kind with evidence, or returns `unclear` with the reason the row's
 * action line could not be read — the one thing it never does is default to `repo-code`.
 *
 * The `动作类型` column is deliberately not an input here: `inspectAction()` reads it before this
 * runs, so the word list can never overrule a written-down value.
 */
function inspectCells(input: ActionInput): Omit<ActionFacts, 'source'> {
  const fields = FIELD_VALUES.map(({ field, read }) => ({ field, text: flatten(read(input)) }))
  const hits: Hit[] = []

  for (const { field, text } of fields) {
    if (text === '') continue
    const role = FIELD_ROLES[field]
    if (role.kinds === 'none') continue
    for (const { kind, terms } of LEXICON) {
      if (role.kinds === 'decision' && kind !== 'decision') continue
      const matched: string[] = []
      let first: { index: number; length: number } | undefined
      for (const term of terms) {
        const found = occurrences(text, term)
        if (found.length === 0) continue
        matched.push(term)
        const index = found[0] as number
        if (!first || index < first.index) first = { index, length: term.length }
      }
      if (!first || matched.length === 0) continue
      hits.push({
        kind,
        field,
        matched,
        evidence: evidenceAt(text, first.index, first.length),
        decisive: role.decisive,
        refusal: role.refusal,
        order: hits.length,
      })
    }
  }

  const precedence = LEXICON.map((entry) => entry.kind)
  const rank = (kind: Exclude<ActionKind, 'unclear'>): number => precedence.indexOf(kind)

  // Admission needs an action field; refusal needs a cell that is allowed to refuse. Everything
  // else is kept as context, so "简要描述 says 发布" is visible without becoming the verdict.
  const byKind = new Map<Exclude<ActionKind, 'unclear'>, Hit>()
  for (const hit of hits) {
    const seen = byKind.get(hit.kind)
    if (!seen) { byKind.set(hit.kind, hit); continue }
    // A hit in 下一步 is better evidence than the same hit in 批注, and a refusal hit is better
    // than a context-only one.
    const better = (hit.decisive && !seen.decisive) || (hit.refusal && !seen.refusal)
    if (better) byKind.set(hit.kind, hit)
  }

  const all = [...byKind.values()]
  const candidates = all.filter((hit) => hit.decisive || (!hit.kind.startsWith('repo-') && hit.refusal))
  const context = all.filter((hit) => !candidates.includes(hit))

  if (candidates.length === 0) {
    const reason = unclearReason(fields, context)
    return {
      kind: 'unclear',
      matched: [],
      evidence: '',
      field: '',
      reason,
      alternatives: [...context].sort((a, b) => rank(a.kind) - rank(b.kind)).map(toMatch),
    }
  }

  const sorted = [...candidates].sort((a, b) => rank(a.kind) - rank(b.kind))
  const winner = chooseRepoKind(sorted, input.contribution)
  const alternatives = [
    ...sorted.filter((hit) => hit.kind !== winner.kind),
    ...context,
  ].sort((a, b) => rank(a.kind) - rank(b.kind)).map(toMatch)

  return {
    kind: winner.kind,
    matched: winner.matched,
    evidence: winner.evidence,
    field: winner.field,
    reason: winner.kind.startsWith('repo-')
      ? `「${winner.field}」里是仓内可做的动作（命中 ${winner.matched.join('、')}）`
      : `「${winner.field}」里的动作不在仓内（命中 ${winner.matched.join('、')}），按最严优先级判为 ${winner.kind}${alternatives.length > 0 ? '；同时命中 ' + alternatives.map((entry) => entry.kind).join('、') : ''}`,
    alternatives,
  }
}

/**
 * The structured column's value as a kind, or `undefined` when it is not one.
 *
 * Case and surrounding whitespace are tolerated (`Repo-Code` is `repo-code`), because the cell is
 * typed by a person. Anything else is not guessed at: `auto`, `待定`, `repo code` and a typo all
 * come back `undefined`, and `inspectAction()` turns that into `unclear` rather than into prose.
 *
 * The comparison itself lives in `action-vocabulary.ts`, so this function cannot disagree with the
 * write-back path about what a legal spelling is.
 */
export function readActionColumn(value: string | undefined): ActionKind | undefined {
  return normalizeActionKind(value)
}

/**
 * The fact the Gate reads: the structured column when the row has a usable one, prose otherwise.
 *
 * Three cases, and the reason says which one happened:
 *   - a valid `动作类型` → that kind, `source: 'column'`. It wins even when `下一步` reads like
 *     something else; the word-list verdict is kept in `alternatives` so the disagreement is
 *     auditable, not invisible.
 *   - a blank cell, or no column at all → the word list, `source: 'text'`. This is the pre-column
 *     behaviour, unchanged, and it is what fills the column in the first place.
 *   - a value that is not a kind → `unclear`, `source: 'column'`. Deliberately *not* a fallback:
 *     a typo must stop the row, not hand it to a word list that may call it `repo-code`.
 */
export function inspectAction(input: ActionInput): ActionFacts {
  const lexical = inspectCells(input)
  // One reading, four states (`action-vocabulary.ts`): a blank cell and an absent column are both
  // `missing`, a recoverable variant is `normalized`, everything else is `invalid`.
  const cell = readActionCell(input.actionType)

  if (cell.state === 'missing') {
    if (input.actionType === undefined) return { ...lexical, source: 'text' }
    return { ...lexical, source: 'text', reason: `「动作类型」列值为空，已退回词表推断；${lexical.reason}` }
  }

  const columnKind = cell.kind
  const written = cell.raw.trim()
  const evidence = evidenceAt(cell.value, 0, cell.value.length)
  const lexicalMatch = lexical.kind === 'unclear' ? undefined : toMatch({
    kind: lexical.kind,
    field: lexical.field as ActionField,
    matched: lexical.matched,
    evidence: lexical.evidence,
    decisive: lexical.field !== '' && FIELD_ROLES[lexical.field as ActionField].decisive,
    refusal: true,
    order: 0,
  })
  const alternatives = [
    ...(lexicalMatch && lexicalMatch.kind !== columnKind ? [lexicalMatch] : []),
    ...lexical.alternatives,
  ]

  if (columnKind === undefined) {
    return {
      kind: 'unclear',
      source: 'column',
      matched: [],
      evidence,
      field: '动作类型',
      reason: `「动作类型」列值「${evidenceAt(written, 0, written.length)}」不在允许集合内（${ACTION_KINDS.join(' / ')}），按 unclear 处理并拒绝，未退回词表推断`,
      alternatives,
    }
  }

  const agreement = lexical.kind === columnKind
    ? '，与词表推断一致'
    : lexical.kind === 'unclear'
      ? '，词表无命中，以列值为准'
      : `，优先于词表推断（词表判为 ${lexical.kind}）`
  // A rescued cell says so: the reader of a reason should not have to re-read the raw value to
  // learn that the table wrote `Repo-Code` and the Gate read `repo-code`.
  const rescued = cell.state === 'normalized' ? `；列值「${evidenceAt(written, 0, written.length)}」已归一化为 ${columnKind}` : ''

  return {
    kind: columnKind,
    source: 'column',
    // No word matched: the cell is one token from a closed set. `policy.refuseAction()` reads
    // `source` so a column-written repo kind is not refused for having no matched words.
    matched: [],
    evidence,
    field: '动作类型',
    reason: `「动作类型」列写死为 ${columnKind}（结构化列${rescued}）${agreement}`,
    alternatives,
  }
}

/**
 * Which repo kind wins when more than one matched.
 *
 * `下一步` is usually a compound ("编译 + 补单测"), so the tie is broken by `贡献类型` when that
 * cell names one of the matched kinds, and by precedence otherwise. `贡献类型` never *creates* a
 * repo kind on its own: a tag is not an action line.
 */
function chooseRepoKind(sorted: readonly Hit[], contribution: string | undefined): Hit {
  const first = sorted[0] as Hit
  if (!first.kind.startsWith('repo-')) return first
  const tagged = CONTRIBUTION_KINDS[flatten(contribution ?? '')]
  if (!tagged) return first
  return sorted.find((hit) => hit.kind === tagged) ?? first
}

function toMatch(hit: Hit): ActionMatch {
  return { kind: hit.kind, field: hit.field, matched: hit.matched, evidence: hit.evidence, decisive: hit.decisive }
}

/**
 * Why the action line could not be read.
 *
 * The text names the actual gap: an empty cell, no word from the list at all, or repo words that
 * only appear outside the action fields. "Missing" is a fact about this module's word list too,
 * and saying so is the point of fail-closed.
 */
function unclearReason(
  fields: readonly { field: ActionField; text: string }[],
  context: readonly Hit[],
): string {
  const actionText = fields
    .filter(({ field }) => ACTION_FIELDS.includes(field))
    .map(({ text }) => text)
    .join(' ')
  if (actionText.trim() === '') return '下一步为空，没有可判定的动作'
  if (context.length > 0) {
    const where = context.map((hit) => `${hit.field}提到 ${hit.matched.join('、')}`).join('；')
    return `动作字段没有可执行的词，只有 ${where}，不足以准入`
  }
  return '未命中任何动作词：动作字段里没有代码/测试/文档/现场/发布/密钥/配置/拍板一类可判定证据'
}

/**
 * The refusal code per kind, and the one place "is this repo work" is decided.
 *
 * Typed as a total `Record<ActionKind, …>` on purpose: adding a kind to the vocabulary becomes a
 * compile error here until someone says whether an unattended round may do it, and with which
 * refusal it is turned away. A `switch` would have let a new kind fall through to `undefined`,
 * i.e. silently admit it.
 */
const REFUSALS: Readonly<Record<ActionKind, ActionRefusal | undefined>> = {
  'repo-code': undefined,
  'repo-test': undefined,
  'repo-doc': undefined,
  'field-ops': 'action-field-ops',
  release: 'action-release',
  secret: 'action-needs-secret',
  config: 'action-needs-config',
  decision: 'action-needs-decision',
  unclear: 'action-unclear',
}

/** Whether a kind is work an unattended round may do inside a repo. */
export function isRepoWork(kind: ActionKind): boolean {
  return REFUSALS[kind] === undefined
}

/** The Gate's refusal code for a kind, or `undefined` when the action is repo work. */
export function actionRefusal(kind: ActionKind): ActionRefusal | undefined {
  return REFUSALS[kind]
}
