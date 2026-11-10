/**
 * The item contract test.
 *
 * `schemas/item.schema.json` is the machine-checkable shape every source adapter must produce.
 * The check is deliberately small (required / type / enum / minimum / minLength) so it runs
 * offline, without pulling a JSON Schema meta-schema over the network.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LocalJsonSource } from '../src/source/local-json.ts'
import { normalizeItem } from '../src/source/provider.ts'

const schemaPath = fileURLToPath(new URL('../schemas/item.schema.json', import.meta.url))

interface SchemaDef {
  required?: string[]
  properties?: Record<string, { type?: string | string[]; enum?: string[]; minimum?: number; minLength?: number }>
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number'
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    default: return true
  }
}

/** Returns the list of contract violations; an empty list means the item conforms. */
export function contractViolations(item: Record<string, unknown>, schema: SchemaDef): string[] {
  const violations: string[] = []
  for (const name of schema.required ?? []) {
    if (!(name in item)) violations.push(`missing required field '${name}'`)
    else if (item[name] === null) violations.push(`required field '${name}' is null`)
  }
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    if (!(name in item)) continue
    const value = item[name]
    if (value === null || value === undefined) continue
    const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : []
    if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
      violations.push(`field '${name}' must be ${types.join('|')}, got ${typeof value}`)
      continue
    }
    if (spec.enum && !spec.enum.includes(String(value))) {
      violations.push(`field '${name}' must be one of [${spec.enum.join(',')}], got '${String(value)}'`)
    }
    if (spec.minimum !== undefined && typeof value === 'number' && value < spec.minimum) {
      violations.push(`field '${name}' must be >= ${spec.minimum}, got ${value}`)
    }
    if (spec.minLength !== undefined && typeof value === 'string' && value.length < spec.minLength) {
      violations.push(`field '${name}' must be at least ${spec.minLength} characters`)
    }
  }
  return violations
}

describe('item contract', () => {
  it('every normalized item conforms to the schema', async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaDef
    const source = new LocalJsonSource({ path: fileURLToPath(new URL('./fixtures/items.json', import.meta.url)) })
    const items = await source.listItems()
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(contractViolations(item as unknown as Record<string, unknown>, schema)).toEqual([])
    }
  })

  it('rejects an item without an id', async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaDef
    const item = normalizeItem({ title: 'no id' })
    expect(contractViolations(item as unknown as Record<string, unknown>, schema)).toContain("field 'id' must be at least 1 characters")
  })

  it('rejects an unknown priority', async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaDef
    const item = normalizeItem({ id: 'x', title: 'x', priority: 'P9' })
    expect(contractViolations(item as unknown as Record<string, unknown>, schema)).toEqual([])
    const raw = { id: 'x', title: 'x', priority: 'P9', intervalMin: 0 }
    expect(contractViolations(raw, schema)).toContain("field 'priority' must be one of [P0,P1,P2], got 'P9'")
  })
})
