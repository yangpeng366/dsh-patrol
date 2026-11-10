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

Four rules hold it together:

1. **The Gate is code; the Assessment is the model.** Who may originate work is decided without a
   model. Whether the work is worth doing is decided by the model, on bounded facts only.
2. **Authority is a Mandate, not a string.** It records the policy version it was granted under,
   so tightening the policy never silently rewrites work already in flight.
3. **A row that did not change re-triggers nothing.** Trigger ids are content-addressed, so a
   round is cheap and a quiet row stays quiet.
4. **An unset allowlist refuses; it never widens.** Since Policy v3 an empty `autonomousRepos` is
   `repo-allowlist-unset`, not "every repo" — a forgotten setting must not become a permission.

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
| `policyVersion` | `v3` | recorded on every Mandate; v3 makes the repo allowlist fail-closed |
| `paused` | `false` | a paused Policy admits nothing but keeps its rules |
| `acceptMode` | `observe` | `off` / `observe` / `auto` |
| `decisionLogPath` | — (off) | append-only JSONL of every decision; relative paths resolve against the process working directory |
| `autonomousRepos` | `[]` | repo prefixes an unattended round may act inside; **empty refuses every row** (`repo-allowlist-unset`), and once set a row with no repo, an uncloned repo, or a repo outside every prefix is refused |
| `allowAnyRepo` | `false` | explicit opt-in to the pre-v3 "any repo" rule, for tests and interactive callers only; never inferred from an empty `autonomousRepos` |
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

Same table, same day, with a 15-repo allowlist (this run predates v3; v2 read the allowlist as
opt-in):

```
evaluated=78 observed=16 ignored=62 admitted=0
reasons = {"held-by-mode:observe":16,"repo-not-autonomous":42,"no-repo-path":8,
           "read-only-direction":8,"repo-not-cloned":2,"no-next-step":1,"needs-approval":1}
```

**Policy v3 changes the default.** The restriction is no longer opt-in: with `autonomousRepos` empty
every unattended row is refused with `repo-allowlist-unset` before assessment, so an existing host
that upgrades without configuring a list goes quiet instead of going wide. The old "any repo" rule
survives only behind an explicit `allowAnyRepo: true`, which is meant for tests and interactive
sessions — never for a scheduled round. The 16 would-accept rows of 2026-11-10 were classified one
by one, and the resulting allowlist is in [`docs/policy-v3-allowlist.md`](docs/policy-v3-allowlist.md):

```yaml
config:
  policyVersion: v3
  autonomousRepos:
    - 'E:\gitAll\openeyes'
```

`--log` writes the same append-only JSONL the plugin writes, so `scripts/policy-audit.mjs` can read
a shadow round back. Prefixes are compared after normalising case, separators and trailing slashes,
and a sibling directory (`dsh-patrol-old` next to `dsh-patrol`) is not inside the prefix.

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

## 同仓并发演练（same-repo rehearsal）

方向表里常常有多行指向同一个仓，而一行就是一个 thread；所以「同一 thread 只有一条线」并不等于
「同一个仓只有一条线」。`ticket-already-open` 是切 `auto` 前的最后一道闸，这条演练把它变成可复跑的
证据：走 Engine 的真实路径（`runRound()` → `Policy.gate()` → `Assessor.assess()` → `openTicket()` →
sink），不是只调 `gate()`。

```powershell
node scripts/same-repo-rehearsal.ts    # 全 PASS 退出码 0，任一失败退出码 1
pnpm test -- same-repo                # 同一套场景的 vitest 入口（共用同一模块和断言）
```

判据（任一不满足即失败）：

| 场景 | 判据 |
| --- | --- |
| 同仓两行，先后到达 | 第一条 `admitted` 并开票；第二条 `ignored` / `ticket-already-open`；ticket 总数 1 |
| 同仓两行，两轮同时发起 | 只有 1 条 `admitted`、1 个 open ticket、1 次派发；其余全为 `ticket-already-open`；两条 Assessment 时间窗重叠 > 0 |
| ticket ended 之后 | 第二条仍被挡；`endTicket(person)` 后第三条 `admitted`；open=1、总数 2 |
| 两个不同 repo 同时发起 | 每个 repo 各 1 条 open ticket，共 2 条，都被放行 |
| 白名单外同仓 | 两条都是 `ignored` / `repo-not-autonomous`，0 ticket（仓库层先于 ticket 层，并发绕不过） |

「同时发起」是字面意思：`runRound()` 连调两次、两次之间不 `await`，报告会打印两次 Assessment 的
时间窗并断言重叠。一次真实的并发样本：

```
[2] 同仓两行，两轮 runRound() 同时发起（不 await 中间）  (same-repo-concurrent)
    trg_recB1    verdict=admitted  reason=row-carries-next-step ticket=tkt_08830b5e1a4c  round=rnd_20261111T010000Z_1
    trg_recB2    verdict=ignored   reason=ticket-already-open  ticket=-  round=rnd_20261111T010000Z_1
    trg_recB1    verdict=ignored   reason=ticket-already-open  ticket=-  round=rnd_20261111T010000Z_2
    tickets=1 open=1  dispatched=1
    assessor windows: patrol:recB1[141.3..201.9]  patrol:recB1[141.4..202.4]
    overlap=60.5ms  elapsed=61.3ms  (assessor delay=60ms; overlap>0 means at least two assessments were in flight at once)
```

这条演练把 `ticket-already-open` 从「进程内任意 open ticket」收紧为「同一仓的 open ticket」
（`Ticket.repoPath`），并在 `openTicket()` 之前用当前 ticket 集合重新过闸：`Assessor.assess()` 是
`await`，不重检的话两轮可以同时过闸再各自开票。它覆盖的是**单进程内**、同一个 `Engine` 实例的
并发；ticket 在内存里，多进程/多实例不共享，需要靠「一仓一实例」的部署约束。演练不改
`acceptMode`：它证明闸门有效，不构成切 `auto` 的决定。细则见
[`docs/policy-v3-allowlist.md`](docs/policy-v3-allowlist.md) §7。

## Running on Windows

`lark-cli` installs as a shim (`lark-cli.cmd` / `lark-cli.ps1`), which Node cannot spawn by bare
name — the Bitable source goes through `cmd.exe` on Windows and uses the plain binary elsewhere.
Override with `LARK_CLI=/path/to/lark-cli`.

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run — 68 tests
pnpm build       # tsdown
```

Current state: typecheck clean, 68 tests pass, build produces `lib/index.js` + `lib/index.d.ts`.

What the tests actually pin down: the Gate's refusals (needs-approval, read-only, approval state,
no next step, ticket already open, paused), the v3 repo default (empty allowlist refuses, explicit
`allowAnyRepo` is the only way back, prefix hit/miss and case/separator normalisation, the repo
layer staying ahead of the ticket layer), Mandate re-validation across a policy change,
`observe`/`off` holding verdicts back, duplicate-trigger idempotency, content-addressed trigger
ids, the row interval, the Bitable column mapping, and a round that survives a failing write-back.
The decision log adds: one line per decision with no BOM and no truncation, a created directory, a
blocked write that is reported rather than thrown, the empty `decisionLogPath` that writes nothing,
and the audit script's counts, bad-line line numbers and `wouldAccept` filter (run as the real CLI).
The same-repo rehearsal adds: one open ticket per repo across five Engine-path scenarios, including
two rounds launched without an intervening `await` (the Assessor windows are asserted to overlap),
and a repo layer that refuses every row outside the allowlist before the ticket layer runs.

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
