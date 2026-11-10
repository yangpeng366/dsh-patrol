/**
 * Mapping between a direction row and the domain model.
 *
 * This file is the part that is ours rather than the prototype's: it encodes how a row of a
 * direction table (授权边界 / 协作形态 / 审批状态 / 巡检间隔 / 下一步) turns into a Trigger,
 * a Gate input and a Ticket seed.
 */
import { createHash } from 'node:crypto'
import type { DirectionFacts } from './core/policy.ts'
import type { Trigger } from './core/model.ts'
import type { DirectionItem } from './source/provider.ts'

/** Hashes the fields that make a row's work different. A row that did not change produces the same id. */
export function itemFingerprint(item: DirectionItem): string {
  const material = [
    item.id, item.title, item.nextStep, item.currentStage, item.priority,
    item.authorization, item.collaboration, item.approval, item.pendingAction,
    item.repoPath, item.lastRun ?? '',
  ].join('\u0001')
  return createHash('sha1').update(material).digest('hex').slice(0, 16)
}

/** The row's shape as the Gate sees it. */
export function itemFacts(item: DirectionItem): DirectionFacts {
  return {
    authorization: item.authorization,
    collaboration: item.collaboration,
    approval: item.approval,
    priority: item.priority,
    fake: item.fake,
    nextStepPresent: item.nextStep.trim().length > 0,
  }
}

/** One direction row is one thread: its follow-up work joins the same thread. */
export function itemThreadKey(item: DirectionItem): string {
  return `patrol:${item.id}`
}

/** What the Ticket is allowed to touch. */
export function itemScope(item: DirectionItem): string {
  const repo = item.repoPath.trim() || '(无仓库)'
  return `方向 ${item.id}（${item.title}）· ${repo} · ${item.priority}`
}

/**
 * Turns a row into a Trigger.
 *
 * The id is content-addressed: the same row state always yields the same Trigger id, so a row that
 * did not change does not re-trigger work. The Trigger carries facts only — authority is granted
 * later by the Gate and recorded in the Mandate.
 */
export function itemToTrigger(item: DirectionItem, now: string): Trigger {
  const fingerprint = itemFingerprint(item)
  return {
    id: `trg_${item.id}_${fingerprint}`,
    source: 'direction-table',
    threadKey: itemThreadKey(item),
    at: now,
    strength: 'explicit',
    meta: {
      origin: `row:${item.id}`,
      itemId: item.id,
      title: item.title,
      nextStep: item.nextStep,
      repoPath: item.repoPath,
      priority: item.priority,
      fake: item.fake,
      stage: itemStage(item),
      currentStage: item.currentStage,
      threadId: item.threadId,
      facts: itemFacts(item),
    },
  }
}

/** The stage a Ticket starts in, taken from the row. */
export function itemStage(item: DirectionItem): string {
  return item.currentStage.trim() || '探索'
}

/** Whether a row is due at `now`, by its own interval. */
export function itemIsDue(item: DirectionItem, now: Date): boolean {
  const interval = item.intervalMin > 0 ? item.intervalMin : 60
  if (!item.lastRun) return true
  const last = new Date(item.lastRun)
  if (Number.isNaN(last.getTime())) return true
  return (now.getTime() - last.getTime()) / 60_000 >= interval
}