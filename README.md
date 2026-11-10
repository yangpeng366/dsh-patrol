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
| `decisionLogPath` | — (off) | append-only JSONL of every decision; relative paths resolve against the process working directory |
| `autonomousRepos` | `[]` | repo prefixes an unattended round may act inside; empty means no restriction, and once set a row with no repo, an uncloned repo, or a repo outside every prefix is refused |
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

That first number was the reason for the repo rule. Sixty-eight rows carried a next step, but they
included 23 rows pointing at 现场 repositories and 8 whose `仓库路径` was a sentence rather than a
path - none of which should ever start unattended. Set `autonomousRepos` and the Gate refuses
those rows before assessment (`no-repo-path`, `repo-not-cloned`, `repo-not-autonomous`):

```bash
node scripts/shadow-run.mjs --log .artifacts/patrol-decisions.jsonl \
  --repos 'D:\gitAll\dsh-patrol;D:\gitAll\patrol-scaffold;E:\gitAll\openeyes'
```

Same table, same day, with a 15-repo allowlist:

```
evaluated=78 observed=16 ignored=62 admitted=0
reasons = {"held-by-mode:observe":16,"repo-not-autonomous":42,"no-repo-path":8,
           "read-only-direction":8,"repo-not-cloned":2,"no-next-step":1,"needs-approval":1}
```

The allowlist is opt-in on purpose: with `autonomousRepos` empty every row keeps the old
behaviour, so an existing host does not change meaning on upgrade. `--log` writes the same
append-only JSONL the plugin writes, so `scripts/policy-audit.mjs` can read a shadow round back.

## Decision audit（决策审计）

A round is gone the moment it returns: without a log, what the Engine decided and why only ever
existed in the host log. Set `decisionLogPath` and every `DecisionRecord` is also appended to a
JSONL file — one line per decision, UTF-8 without BOM, append-only:

```yaml
- insert:
    - id: dsh-patrol
      name: dsh-patrol
      config:
        decisionLogPath: .artifacts/patrol-decisions.jsonl
```

Each line carries `ts`, `roundId`, `verdict`, `reason`, `threadKey`, `triggerId`, `evalId`,
`ticketId` (when a Ticket was opened) and `wouldAccept` (when an accept was held back for review):

```json
{"ts":"2026-11-10T14:33:42.920Z","roundId":"rnd_20261110T010000Z_1","verdict":"observed","reason":"held-by-mode:observe","threadKey":"patrol:rec1","triggerId":"rec1","evalId":"eval_3ff45714ea4c","wouldAccept":{"title":"补齐审计脚本","scope":"D:\\gitAll\\demo","rules":["next-step-present"]}}
```

Reading it back is what turns `observe` mode into a decision:

```bash
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions.jsonl          # readable summary
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions.jsonl --json   # machine-readable
```

Against a five-row round that log prints:

```
records: 5

by verdict:
  admitted     0
  observed     2
  ignored      2
  unavailable  1

by reason:
      2  held-by-mode:observe
      1  model-timeout
      1  no-next-step
      1  read-only-direction

would-accept (held for review): 2
  #1 2026-11-10T14:33:42.920Z patrol:rec1 verdict=observed reason=held-by-mode:observe
      title: 补齐审计脚本
      scope: D:\gitAll\demo
      rules: next-step-present
```

`--json` emits the same thing as one object (`total`, `badLines`, `verdicts`, `reasons`,
`wouldAccept`), so a digest job can gate on `wouldAccept.length` instead of grepping text.

Four rules the implementation keeps:

- **Path resolution.** A relative path resolves against the *process working directory* — the same
  rule `tasksFile` follows — not against the plugin or package root. Absolute paths are used
  verbatim, and `~` is not expanded: that is the shell's job, not a plugin's guess.
- **No config, no file.** With `decisionLogPath` unset (the default) no log is built at all: no
  file, no directory, and the decision callback behaves exactly as before.
- **A failed write never stops the patrol.** `DecisionLog.append` creates a missing directory and,
  on failure, returns `{ ok: false, error }` *and* calls the `onError` callback the host wires to
  `dsh-patrol decision log write failed: …`. A full disk costs history, not the round.
- **Bad lines are data.** A truncated or hand-edited line is reported with its line number and
  skipped; the audit keeps counting and still exits 0.

## Running on Windows

`lark-cli` installs as a shim (`lark-cli.cmd` / `lark-cli.ps1`), which Node cannot spawn by bare
name — the Bitable source goes through `cmd.exe` on Windows and uses the plain binary elsewhere.
Override with `LARK_CLI=/path/to/lark-cli`.

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run — 47 tests
pnpm build       # tsdown
```

Current state: typecheck clean, 47 tests pass, build produces `lib/index.js` + `lib/index.d.ts`.

What the tests actually pin down: the Gate's refusals (needs-approval, read-only, approval state,
no next step, ticket already open, paused), Mandate re-validation across a policy change,
`observe`/`off` holding verdicts back, duplicate-trigger idempotency, content-addressed trigger
ids, the row interval, the Bitable column mapping, and a round that survives a failing write-back.
The decision log adds: one line per decision with no BOM and no truncation, a created directory, a
blocked write that is reported rather than thrown, the empty `decisionLogPath` that writes nothing,
and the audit script's counts, bad-line line numbers and `wouldAccept` filter (run as the real CLI).

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
