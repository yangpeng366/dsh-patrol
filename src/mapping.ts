/**
 * Mapping between a direction row and the domain model.
 *
 * This file is the part that is ours rather than the prototype's: it encodes how a row of a
 * direction table (授权边界 / 协作形态 / 审批状态 / 巡检间隔 / 下一步) turns into a Trigger,
 * a Gate input and a Ticket seed.
 */
import { createHash } from 'node:crypto'
import type { DirectionFacts } from './core/policy.ts'
import { inspectAction, type ActionFacts } from './core/action-facts.ts'
import { inspectRepoPath, type RepoExistsFact, type RepoInspectOptions } from './core/repo-facts.ts'
import type { Trigger } from './core/model.ts'
import type { DirectionItem } from './source/provider.ts'

/** Hashes the fields that make a row's work different. A row that did not change produces the same id. */
export function itemFingerprint(item: DirectionItem, repoState: 'exists' | 'missing' | 'unknown' = 'unknown'): string {
  const material = [
    item.id, item.title, item.nextStep, item.currentStage, item.priority,
    item.authorization, item.collaboration, item.approval, item.pendingAction,
    // `巡检间隔` is part of the row's state, not just its schedule: 停跑 → 恢复 has to produce a
    // new Trigger, or the row that was refused as `schedule-stopped` could never be re-judged.
    item.intervalMin,
    item.repoPath, item.lastRun ?? '',
    // The structured action kind is state too: writing `repo-code` into a row that read as 现场 must
    // re-judge it, not be swallowed as a duplicate Trigger. Blank and absent hash the same, so a
    // table without the column produces exactly the ids it produced before the column existed.
    item.actionType ?? '',
    // Repo existence is state too (Policy v4): cloning `D:\gitAll\patrol-scaffold` after the row
    // was refused as `repo-missing` must re-judge the row, and `receive()` dedupes by Trigger id.
    // The parameter is explicit so `itemFingerprint()` stays a pure function of its arguments.
    repoState,
  ].join('\u0001')
  return createHash('sha1').update(material).digest('hex').slice(0, 16)
}

/** The row's repo cell, probed once. Kept separate so a caller can inspect without building a Trigger. */
export function itemRepoFact(item: DirectionItem, options: RepoInspectOptions = {}): RepoExistsFact {
  return inspectRepoPath(item.repoPath, options)
}

/**
 * The row's action type, read once.
 *
 * The structured `动作类型` cell goes in first and, when it holds a kind, it *is* the answer. The
 * six free-text cells are the fallback: they are what decides a row whose column is absent, blank
 * or unreadable (§6.2 of the triage doc). Nothing here reads a file or calls a model.
 */
export function itemActionFact(item: DirectionItem): ActionFacts {
  return inspectAction({
    actionType: item.actionType,
    nextStep: item.nextStep,
    description: item.description,
    userNote: item.userNote,
    authorization: item.authorization,
    contribution: item.contribution,
    approval: item.approval,
  })
}

/** The row's shape as the Gate sees it. */
export function itemFacts(item: DirectionItem, repoExists?: RepoExistsFact, actionFacts?: ActionFacts): DirectionFacts {
  return {
    authorization: item.authorization,
    collaboration: item.collaboration,
    approval: item.approval,
    priority: item.priority,
    fake: item.fake,
    nextStepPresent: item.nextStep.trim().length > 0,
    // Structured, never derived from the prose: the Gate must not read `下一步` for keywords.
    intervalMin: item.intervalMin,
    repoPath: item.repoPath,
    // Structured too: `仓库路径` is a cell, and "is there a repo there" is a filesystem answer.
    repoExists,
    // And what the next step *is*: the repo cell says where, this says whether the work is inside it.
    actionFacts: actionFacts ?? itemActionFact(item),
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
export function itemToTrigger(item: DirectionItem, now: string, options: RepoInspectOptions = {}): Trigger {
  const repoExists = itemRepoFact(item, options)
  const actionFacts = itemActionFact(item)
  const fingerprint = itemFingerprint(item, repoExists.exists ? 'exists' : 'missing')
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
      facts: itemFacts(item, repoExists, actionFacts),
      repoExists,
      actionFacts,
    },
  }
}

/** The stage a Ticket starts in, taken from the row. */
export function itemStage(item: DirectionItem): string {
  return item.currentStage.trim() || '探索'
}

/**
 * Whether the row's schedule is stopped (停跑).
 *
 * `0` and a blank cell both normalize to `0` (`normalizeItem()` folds them), and the table's own
 * `巡检占用` column spells the convention out: `0=禁用巡检`. This is the one place that sentence
 * becomes a predicate, so the due filter and the round's log agree on which rows are stopped.
 */
export function itemIsStopped(item: DirectionItem): boolean {
  return !(item.intervalMin > 0)
}

/**
 * Whether a row is due at `now`, by its own interval.
 *
 * A stopped row is never due: it used to be read as "every 60 minutes", which put it through the
 * Gate once an hour only to be refused as `schedule-stopped` — a refusal that changed nothing and
 * filled the decision log with noise. The row does not disappear from the log, though: the round
 * records it as `stopped` before anything is judged (`PatrolRunner.runOnce` → `Engine.runRound`).
 */
export function itemIsDue(item: DirectionItem, now: Date): boolean {
  if (itemIsStopped(item)) return false
  const interval = item.intervalMin
  if (!item.lastRun) return true
  const last = new Date(item.lastRun)
  if (Number.isNaN(last.getTime())) return true
  return (now.getTime() - last.getTime()) / 60_000 >= interval
}
