# dsh-patrol

A DeepSeek Harness plugin that turns a **row-based task source** into DSH-native work:
read a direction table (Feishu Bitable by default), turn each due row into a Trigger, admit it
under a versioned Policy, open a Ticket for what was admitted, and dispatch that Ticket.

## Why this exists

DeepSeek Harness is "everything is a plugin", and DeepSeek's own research prototype
[`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT) defines
the domain model a proactive agent needs: **Source → Trigger → Thread → Eval (Gate + Assessment) →
Mandate → Ticket → Assignment → Executor**.

That prototype listens to GitHub and Feishu. It has no table-shaped source — and a table is how
most teams actually keep their work: one row per direction, with its own priority, interval,
authorization and approval state already in columns. This plugin fills that gap and encodes the
mapping in `docs/001-domain.md`.

## How it works

```
row (Bitable)  ──▶ Source.listItems()      ──▶ due rows only (row's own interval)
                      │
                      ▼
                  itemToTrigger()            content-addressed id: an unchanged row re-triggers nothing
                      │
                      ▼
                  Policy.gate()              pure code, no model: who may originate work
                      │
                      ▼
                  Assessor.assess()          bounded facts, never authority: is this worth doing
                      │
                      ▼
                  Ticket + Assignment        ──▶ Dispatcher (codex / dsh / log)
                      │
                      ▼
                  source.writeBack()         current stage, next step, achievement
```

Three rules hold it together:

1. **The Gate is code; the Assessment is the model.** Who may originate work is decided without a
   model. Whether the work is worth doing is decided by the model, on bounded facts only.
2. **Authority is a Mandate, not a string.** It records the policy version it was granted under,
   so tightening the policy never silently rewrites work already in flight.
3. **A row that did not change re-triggers nothing.** Trigger ids are content-addressed, so a
   round is cheap and a quiet row stays quiet.

## The column mapping

| Direction table column | Becomes |
| --- | --- |
| `项目名` | Ticket title |
| `下一步` | what the Assessment judges; empty ⇒ no work |
| `优先级` | ordering (P0 first) |
| `授权边界` | `自主` ⇒ explicit work · `需审批` ⇒ refused · `只读` ⇒ refused |
| `协作形态` | `approve` ⇒ inferred candidate, never explicit |
| `审批状态` | `已通过` required; `待审` / `已忽略` / `阻塞` refuse the row |
| `巡检间隔(分钟)` | the row's own due rule |
| `仓库路径` | the Ticket's scope, and the working directory |
| `codex_thread_id` | the session to resume |
| `当前阶段` | the Ticket's stage |
| `外部成就` | where the round's result is appended |
| `待审行动` | the action waiting for a human |

## Install

```bash
pnpm add dsh-patrol
```

Then insert the bundle in your profile patch:

```yaml
- insert:
    - id: dsh-patrol
      name: dsh-patrol
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `kind` | `bitable` | `bitable` or `local-json` |
| `baseToken` / `tableId` | — | the table to read (Bitable) |
| `tasksFile` | — | the JSON file to read (local-json) |
| `identity` | `user` | identity used for the Bitable read |
| `policyVersion` | `v1` | recorded on every Mandate |
| `paused` | `false` | a paused Policy admits nothing but keeps its rules |
| `acceptMode` | `observe` | `off` / `observe` / `auto` |
| `roundIntervalMs` | `600000` | how often a round runs |
| `dispatcher` | `log` | `log` / `codex` / `dsh` |

**`observe` is the default on purpose.** It records what *would* have been accepted and starts
nothing, so a table of directions can be run in shadow mode first and only then opened up.


## Shadow run against a real table

`observe` mode is meant to be run against a live table before anything is allowed to start:

```bash
export PATROL_BASE_TOKEN=<base token>
export PATROL_TABLE_ID=<table id>
node scripts/shadow-run.mjs
```

It reads the table, judges every row, and prints what **would** be accepted, with the reason each
refused row was refused — then asserts that no ticket was opened. Nothing is written back and
nothing is dispatched.

Against the 78-row direction table on 2026-11-10 it reported:

```
rows read = 78
evaluated=77 observed=68 ignored=9 admitted=0
reasons = {"held-by-mode:observe":68,"read-only-direction":8,"needs-approval":1}
tickets opened = 0  (observe mode must open none)
```

The nine refusals are the Gate doing its job: eight rows are `授权边界=只读` and one is `需审批`.

## Running on Windows

`lark-cli` installs as a shim (`lark-cli.cmd` / `lark-cli.ps1`), which Node cannot spawn by bare
name — the Bitable source goes through `cmd.exe` on Windows and uses the plain binary elsewhere.
Override with `LARK_CLI=/path/to/lark-cli`.

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run — 26 tests
pnpm build       # tsdown
```

Current state: typecheck clean, 26 tests pass, build produces `lib/index.js` + `lib/index.d.ts`.

What the tests actually pin down: the Gate's refusals (needs-approval, read-only, approval state,
no next step, ticket already open, paused), Mandate re-validation across a policy change,
`observe`/`off` holding verdicts back, duplicate-trigger idempotency, content-addressed trigger
ids, the row interval, the Bitable column mapping, and a round that survives a failing write-back.

What is **not** verified here: running inside a live DSH host. The DSH seam is deliberately narrow —
`DshSessionController.prompt` is declared structurally in `src/dispatch.ts` — so a DSH upgrade
changes one file rather than the engine. The `codex` and `log` dispatchers need no DSH host at all.

## External dependencies

None are vendored. The plugin depends on `@deepseek-ai/cordis` and `@deepseek-ai/dsh-agent` (both
published by DeepSeek, both MIT) and on `zod`; the Bitable source shells out to `lark-cli`, which
must be installed and authenticated separately. See `references/external-dependencies.md` in
`patrol-scaffold` for the house rule this follows.

## Credits

- [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
  (MIT, DeepSeek Harness Team) — the domain model this plugin implements.
- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (MIT) — the
  plugin host.

## License

MIT.