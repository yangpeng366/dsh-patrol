/**
 * The `local-json` source: one JSON file, one direction per entry.
 *
 * No credentials, no network — the source used by tests and by anyone who wants to try the
 * plugin without a Feishu account.
 *
 * Two classes share the same file format:
 *   - `LocalJsonSource` is read-only, and is what the fixture-driven tests use;
 *   - `LocalJsonFileSource` also writes back, which is what the `patrol` CLI and the loaded host
 *     plugin use (`createSource`) so a round can run end to end without a Bitable table.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { normalizeItem, type DirectionItem, type SourceProvider, type WriteBackField } from './provider.ts'

export interface LocalJsonSourceOptions {
  path: string
  kind?: string
}

async function readEntries(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error(`LocalJsonSource: ${path} must hold an array of items`)
  return parsed as Record<string, unknown>[]
}

/** Reads a JSON file of direction rows. */
export class LocalJsonSource implements SourceProvider {
  readonly kind: string
  protected readonly path: string

  constructor(options: LocalJsonSourceOptions) {
    this.kind = options.kind ?? 'local-json'
    this.path = options.path
  }

  async listItems(signal?: AbortSignal): Promise<DirectionItem[]> {
    signal?.throwIfAborted()
    return (await readEntries(this.path)).map((entry) => normalizeItem(entry))
  }

  async writeBack(id: string, fields: Partial<Record<WriteBackField, string>>): Promise<void> {
    // A file source has no durable backend of its own; the caller writes the file back.
    void id
    void fields
    throw new Error('LocalJsonSource: write-back is not supported; use LocalJsonFileSource')
  }
}

/** Reads and writes the same file format, for the CLI's `patrol report`. */
export class LocalJsonFileSource extends LocalJsonSource {
  override async writeBack(id: string, fields: Partial<Record<WriteBackField, string>>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const entries = await readEntries(this.path)
    const index = entries.findIndex((entry) => String(entry['id'] ?? '').trim() === id)
    if (index < 0) throw new Error(`LocalJsonFileSource: no row ${id} in ${this.path}`)
    const entry = entries[index] as Record<string, unknown>
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) entry[key] = value
    }
    // Write-then-rename so an interrupted report never leaves a half-written table behind.
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(temp, this.path)
  }
}
