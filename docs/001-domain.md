# The domain, in our words

This plugin implements the domain model of DeepSeek's
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT,
DeepSeek Harness Team), sized down to what a table-shaped source needs. This file records what we
kept, what we changed, and what we deliberately did not copy.

## The objects

| Object | What it is | In our table |
| --- | --- | --- |
| **Source** | an event stream | the direction table (Bitable / JSON) |
| **Trigger** | one immutable event; the unit of audit and idempotency | one row whose state changed |
| **Thread** | a time-ordered series of Triggers | one direction (one row) |
| **Eval** | two layers: **Gate** (pure code) + **Assessment** (model) | "may this start?" then "is it worth doing?" |
| **Mandate** | an immutable grant of authority | the row's `授权边界` + `协作形态` + policy version |
| **Ticket** | a unit of authorized work, with its own state | the direction being worked on |
| **Assignment** | one executor run of a Ticket | one `codex exec` (or one DSH session) |
| **Subscription** | Ticket ↔ Thread fan-out | follow-up rows join the same ticket's thread |
| **Policy** | versioned admission rules | our `授权边界` / `协作形态` / `审批状态` columns |

## What we changed against the prototype

1. **The Gate reads columns, not identities.** The prototype's Gate asks "who is this person and
   are they on the allow-list". Ours asks "what does this row authorize": `授权边界` decides
   whether work may start at all, `协作形态` decides the strength of the claim, `审批状态` is a
   human stop.
2. **`approve` is `accept mode = observe`.** The prototype's `observe` records what it would have
   accepted without acting. Our table's `协作形态=approve` rows get exactly that: the verdict is
   recorded as `observed`, and a human can review the decision history before the gate opens.
3. **Due-ness is a column, not a heartbeat.** The prototype polls sources on their own cadence.
   Our rows carry `巡检间隔(分钟)`, so a round touches only the rows that are actually due.
4. **Trigger ids are content-addressed.** A row that did not change produces the same id, so it
   cannot re-trigger work. The prototype relies on each Source's own read position; ours needs
   none, because the row *is* the position.
5. **Write-back is part of the loop.** Results go back to the row (`当前阶段` / `下一步` /
   `外部成就`), and a failed write-back is reported rather than silently swallowed.

## What we did not copy

- **No management panel.** The prototype's panel is a React app; ours is deliberately absent until
  there is a second operator who needs it.
- **No service manager.** The prototype's `scripts/dsh-superagent` is a Linux-only daemon with
  locking and log rotation. Ours is a plain interval inside the host process.
- **No Threads / Mandates beyond what the table expresses.** A row has one authorization, not a
  per-thread permission model.
- **No cloud separation.** Work runs where the plugin runs.

## Concepts the prototype rejected (and we reject too)

Its `Rejected concepts` section is a useful list of things *not* to model. Two we had to resist
directly:

- **Do not infer "waiting for a person" from free text.** Our `下一步` is free text, so it cannot
  be the source of truth for "blocked" — the table's `审批状态` and `待审行动` columns are.
- **Do not model group membership as an entity.** Our `授权边界` is a per-row column, not a
  membership graph; a row's authorization changes when its column changes, and the Mandate
  records the version it was granted under.

## The rule we keep coming back to

> The Gate decides who may originate work, in code.
> The Assessment decides whether the work is worth doing, in the model.
> Neither ever sees the other's authority.