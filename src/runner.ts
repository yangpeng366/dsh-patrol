/**
 * The runner: one round of the patrol.
 *
 * Read the rows, keep the due ones, turn each into a Trigger, let the Engine admit what the
 * Policy allows, dispatch what became a Ticket, and write the result back to the row.
 */
import { Engine, type RoundSummary } from './core/engine.ts'
import type { Dispatcher } from './dispatch.ts'
import { itemIsDue, itemToTrigger } from './mapping.ts'
import type { DirectionItem, SourceProvider } from './source/provider.ts'

export interface RunnerOptions {
  source: SourceProvider
  engine: Engine
  dispatcher: Dispatcher
  now?: () => Date
  /** Called with each round's summary, for logging or a digest. */
  onSummary?: (summary: RoundSummary, items: DirectionItem[]) => void
  /** Called when a row could not be written back. */
  onWriteBackError?: (itemId: string, error: unknown) => void
}

/** Drives rounds against a source. */
export class PatrolRunner {
  private readonly options: RunnerOptions

  constructor(options: RunnerOptions) {
    this.options = options
  }

  /** Runs one round and returns its summary. */
  async runOnce(): Promise<RoundSummary> {
    const now = this.options.now ? this.options.now() : new Date()
    const items = await this.options.source.listItems()
    const due = items.filter((item) => itemIsDue(item, now))

    for (const item of due) {
      this.options.engine.receive(itemToTrigger(item, now.toISOString()))
    }

    const summary = await this.options.engine.runRound(now)

    for (const ticketId of summary.tickets) {
      const ticket = this.options.engine.ticket(ticketId)
      if (!ticket) continue
      const item = items.find((entry) => entry.id === ticket.sourceItemId)
      const result = await this.options.dispatcher.dispatch(ticket, {
        threadId: item?.threadId ?? null,
        fake: item?.fake ?? false,
        cwd: item?.repoPath || undefined,
      })
      if (!result.ok) continue
      try {
        await this.options.source.writeBack(ticket.sourceItemId, {
          currentStage: ticket.stage,
          nextStep: ticket.mandate.scope,
          achievement: result.detail.slice(0, 2000),
        })
      } catch (error) {
        // A failed write-back must not lose the work that was already done; the next round retries it.
        this.options.onWriteBackError?.(ticket.sourceItemId, error)
      }
    }

    this.options.onSummary?.(summary, items)
    return summary
  }
}