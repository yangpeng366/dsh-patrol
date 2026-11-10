/**
 * The `local-json` source: one JSON file, one direction per entry.
 *
 * No credentials, no network — the source used by tests and by anyone who wants to try the
 * plugin without a Feishu account.
 */
import { readFile } from 'node:fs/promises'
import { normalizeItem, type DirectionItem, type SourceProvider, type WriteBackField } from './provider.ts'

export interface LocalJsonSourceOptions {
  path: string
  kind?: string
}

/** Reads a JSON file of direction rows. */
export class LocalJsonSource implements SourceProvider {
  readonly kind: string
  private readonly path: string

  constructor(options: LocalJsonSourceOptions) {
    this.kind = options.kind ?? 'local-json'
    this.path = options.path
  }

  async listItems(signal?: AbortSignal): Promise<DirectionItem[]> {
    signal?.throwIfAborted()
    const raw = await readFile(this.path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`LocalJsonSource: ${this.path} must hold an array of items`)
    return parsed.map((entry) => normalizeItem(entry as Record<string, unknown>))
  }

  async writeBack(id: string, fields: Partial<Record<WriteBackField, string>>): Promise<void> {
    // A file source has no durable backend of its own; the caller writes the file back.
    void id
    void fields
    throw new Error('LocalJsonSource: write-back is not supported; use a durable source')
  }
}