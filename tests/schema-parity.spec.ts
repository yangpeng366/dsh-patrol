/**
 * Cross-repo item contract parity.
 *
 * `schemas/item.schema.json` is described in both repos as one contract kept in two copies
 * ("改动需同步"): this repo's copy and `patrol-scaffold/schemas/item.schema.json`. Until now that
 * promise was prose only -- nothing failed when one side drifted, and `contract.spec.ts` (which
 * validates items *against this repo's copy*) would stay green either way.
 *
 * Why a separate file instead of more cases in `contract.spec.ts`: `contract.spec.ts` tests
 * behaviour (does a normalized item satisfy the schema?), while this spec tests repo state
 * (are the two copies still the same contract?). Different subject, different failure meaning,
 * different skip condition -- keeping them apart keeps a red test unambiguous.
 *
 * Comparison mirrors tests/verify-item-contract-parity.ps1 in patrol-scaffold:
 *   - key sets at every level must match;
 *   - required / enum / type are compared as sets (order carries no meaning);
 *   - description / title / examples / $comment are annotation-only and deliberately ignored
 *     (each repo is allowed its own wording; gating them would make every prose edit red).
 *
 * The sibling checkout does not exist on CI or on a machine that only cloned this repo, so the
 * check skips there instead of failing. Skip means "cannot judge here", never "verified".
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localSchemaPath = fileURLToPath(new URL('../schemas/item.schema.json', import.meta.url))
const siblingSchemaPath = fileURLToPath(new URL('../../patrol-scaffold/schemas/item.schema.json', import.meta.url))

const ANNOTATION_KEYS = new Set(['description', 'title', 'examples', '$comment'])
const SET_KEYS = new Set(['required', 'enum', 'type'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Flattens a JSON Schema into `path -> canonical value` leaves, so differences can be named
 * one by one instead of compared as one opaque blob. Paths are JSON-pointer style
 * (`/properties/priority/enum`).
 */
function collectLeaves(
  node: unknown,
  path: string,
  keyName: string,
  leaves: Map<string, string>,
): void {
  if (isRecord(node)) {
    for (const [name, value] of Object.entries(node)) {
      // Only scalar annotations are exempt: `properties` may legitimately hold a *schema* whose
      // key happens to be named `description` or `title`, and that one is part of the contract.
      if (ANNOTATION_KEYS.has(name) && !isRecord(value)) continue
      collectLeaves(value, `${path}/${name}`, name, leaves)
    }
    return
  }
  if (Array.isArray(node)) {
    if (SET_KEYS.has(keyName)) {
      const parts = node.map((element) => JSON.stringify(element)).sort()
      leaves.set(path, `[${parts.join(',')}]`)
      return
    }
    node.forEach((element, index) => collectLeaves(element, `${path}/${index}`, keyName, leaves))
    return
  }
  leaves.set(path, JSON.stringify(node))
}

function parityDiffs(local: Map<string, string>, sibling: Map<string, string>): string[] {
  const diffs: string[] = []
  for (const [path, value] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
    const other = sibling.get(path)
    if (other === undefined) diffs.push(`only in dsh-patrol: ${path} = ${value}`)
    else if (other !== value) diffs.push(`DIFF ${path}: dsh-patrol=${value} | patrol-scaffold=${other}`)
  }
  for (const [path, value] of [...sibling].sort(([a], [b]) => a.localeCompare(b))) {
    if (!local.has(path)) diffs.push(`only in patrol-scaffold: ${path} = ${value}`)
  }
  return diffs
}

const siblingPresent = existsSync(siblingSchemaPath)

describe.skipIf(!siblingPresent)('cross-repo item contract parity', () => {
  it('schemas/item.schema.json is key-for-key equivalent to patrol-scaffold', async () => {
    const localDoc: unknown = JSON.parse(await readFile(localSchemaPath, 'utf8'))
    const siblingDoc: unknown = JSON.parse(await readFile(siblingSchemaPath, 'utf8'))

    const localLeaves = new Map<string, string>()
    const siblingLeaves = new Map<string, string>()
    collectLeaves(localDoc, '', '', localLeaves)
    collectLeaves(siblingDoc, '', '', siblingLeaves)

    // Guard against a walker that silently produces nothing: empty vs empty would "pass".
    expect(localLeaves.size).toBeGreaterThan(10)
    expect(parityDiffs(localLeaves, siblingLeaves)).toEqual([])
  })
})
