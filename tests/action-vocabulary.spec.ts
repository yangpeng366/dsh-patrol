import { describe, expect, it } from 'vitest'
import {
  ACTION_KINDS,
  ACTION_MISSING,
  countActionCells,
  describeActionCells,
  describeActionKinds,
  normalizeActionKind,
  readActionCell,
  verifyActionVocabulary,
  writeActionCell,
} from '../src/core/action-vocabulary.ts'
import { inspectAction, LEXICON_KINDS } from '../src/core/action-facts.ts'
/**
 * The nine allowed values, written out here on purpose.
 *
 * This is the one place a test spells the list itself: the module must stay the source of truth,
 * and the way to prove that is to compare it against a frozen copy. If someone adds a tenth kind,
 * this test fails and asks them to update the column's definition deliberately — instead of a
 * report quietly growing an extra `kind-*` line.
 */
const EXPECTED = ['repo-code', 'repo-test', 'repo-doc', 'field-ops', 'release', 'secret', 'config', 'decision', 'unclear']

describe('action vocabulary · the list', () => {
  it('is exactly the nine allowed values, in column order, with no duplicates', () => {
    expect([...ACTION_KINDS]).toEqual(EXPECTED)
    expect(new Set(ACTION_KINDS).size).toBe(EXPECTED.length)
    expect(verifyActionVocabulary()).toEqual([])
  })

  it('gives every kind the word list can produce an entry, so none is unreachable', () => {
    // The word list is the second half of the fact source: a tenth kind added to `ACTION_KINDS`
    // would compile, but no row could ever be inferred as it. `unclear` is the no-evidence answer,
    // so it is the one kind the list must not name.
    expect([...LEXICON_KINDS].sort()).toEqual(ACTION_KINDS.filter((kind) => kind !== 'unclear').sort())
  })

  it('reads every canonical spelling as valid and writes it back unchanged', () => {
    for (const kind of ACTION_KINDS) {
      const reading = readActionCell(kind)
      expect(reading.state).toBe('valid')
      expect(reading.kind).toBe(kind)
      expect(writeActionCell(kind)).toBe(kind)
    }
  })
})

describe('action vocabulary · recoverable variants are normalized', () => {
  it('trims whitespace (including NBSP) and folds case', () => {
    expect(readActionCell('  Repo-Code\u00a0')).toMatchObject({ state: 'normalized', kind: 'repo-code', value: 'repo-code' })
    expect(readActionCell('REPO-TEST').kind).toBe('repo-test')
    expect(normalizeActionKind(' Field-Ops ')).toBe('field-ops')
    expect(writeActionCell(' Release ')).toBe('release')
  })

  it('normalizes inside the classifier too, and says so in the reason', () => {
    const fact = inspectAction({ actionType: 'Repo-Code', nextStep: '补一个单测' })
    expect(fact.kind).toBe('repo-code')
    expect(fact.source).toBe('column')
    expect(fact.reason).toContain('已归一化为 repo-code')
  })

  it('counts a rescued cell as normalized, not as valid', () => {
    const counts = countActionCells(['repo-code', 'Repo-Code', ' REPO-TEST '])
    expect(counts).toMatchObject({ total: 3, valid: 1, normalized: 2, missing: 0, invalidAction: 0 })
    expect(counts.byKind['repo-code']).toBe(2)
    expect(counts.byKind['repo-test']).toBe(1)
  })

  it('keeps the cell\'s own spelling as evidence, so the log quotes what the table said', () => {
    // The kind is folded; the evidence is not, because "the table wrote AUTO" and "the table wrote
    // auto" are different audit trails even though they mean the same kind.
    const bad = inspectAction({ actionType: 'AUTO', nextStep: '补一个单测' })
    expect(bad.kind).toBe('unclear')
    // `AUTO` is not a kind (`auto` is the value the Gate refuses), so this is the invalid path: the
    // evidence must still be the cell as written, not the folded form the comparison used.
    expect(bad.evidence).toBe('AUTO')
    expect(inspectAction({ actionType: 'REPO-CODE' }).evidence).toBe('REPO-CODE')
    expect(inspectAction({ actionType: ' Repo-Code\u00a0' }).evidence).toBe('Repo-Code')
  })
})

describe('action vocabulary · unreadable values are recorded, not guessed', () => {
  // The deliberate bad-value set: every one of these is something a person plausibly types into
  // the column, and none of them is a kind. Only the last (blank space) is "missing", not "bad".
  const BAD = ['auto', '待定', 'Repo Code', 'repo_code', 'repo-code!', '0', 'unclear?', ' ']

  it('refuses every near-miss, and leaves only blank space as "missing"', () => {
    for (const value of BAD.slice(0, -1)) {
      const reading = readActionCell(value)
      expect(reading.state).toBe('invalid')
      expect(reading.kind).toBeUndefined()
      expect(() => writeActionCell(value)).toThrow(/不在词表内/)
    }
    expect(readActionCell(BAD[BAD.length - 1]).state).toBe('missing')
  })

  it('downgrades an unreadable cell to unclear, keeping the written value in the reason', () => {
    const fact = inspectAction({ actionType: 'auto', nextStep: '编译并提交代码' })
    expect(fact.kind).toBe('unclear')
    expect(fact.source).toBe('column')
    expect(fact.evidence).toBe('auto')
    expect(fact.reason).toContain('auto')
    expect(fact.reason).toContain('不在允许集合内')
  })

  it('counts an unreadable cell once as invalid_action and once under unclear, never under a kind', () => {
    const counts = countActionCells(['auto', 'repo-code', '', undefined, '待定'])
    expect(counts).toMatchObject({ total: 5, valid: 1, normalized: 0, missing: 2, invalidAction: 2 })
    expect(counts.byKind['repo-code']).toBe(1)
    // Where the two unreadable rows are recorded — and nowhere else.
    expect(counts.byKind.unclear).toBe(2)
    expect(counts.byKind.release).toBe(0)
    expect(counts.byKind.secret).toBe(0)
    // The four states account for every row; the kinds for every row except the missing ones.
    expect(counts.valid + counts.normalized + counts.missing + counts.invalidAction).toBe(counts.total)
    const kinds = ACTION_KINDS.reduce((sum, kind) => sum + counts.byKind[kind], 0)
    expect(kinds).toBe(counts.total - counts.missing)
  })
})

describe('action vocabulary · missing is its own bucket', () => {
  it('reads an absent column, null, an empty cell and blank space the same way', () => {
    for (const value of [undefined, null, '', '   ', '\u00a0']) {
      expect(readActionCell(value)).toMatchObject({ state: 'missing', value: '' })
    }
  })

  it('groups a mixed column with missing kept apart from the kinds', () => {
    const counts = countActionCells(['repo-code', 'release', 'unclear', undefined, ''])
    expect(counts).toMatchObject({ total: 5, valid: 3, missing: 2, invalidAction: 0 })
    expect(counts.byKind).toEqual({
      'repo-code': 1,
      'repo-test': 0,
      'repo-doc': 0,
      'field-ops': 0,
      release: 1,
      secret: 0,
      config: 0,
      decision: 0,
      unclear: 1,
    })
    expect(describeActionKinds(counts)).toBe('repo-code 1 · release 1 · unclear 1')
    expect(describeActionCells(counts)).toBe(`valid 3 · normalized 0 · ${ACTION_MISSING} 2 · invalid_action 0`)
  })

  it('says (none) when the column is entirely unfilled, and still publishes the missing count', () => {
    const counts = countActionCells([undefined, ''])
    expect(describeActionKinds(counts)).toBe('(none)')
    expect(counts.missing).toBe(2)
    expect(counts.byKind.unclear).toBe(0)
  })
})
