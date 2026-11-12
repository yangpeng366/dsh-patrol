# dsh-patrol

[![Release](https://img.shields.io/github/v/release/yangpeng366/dsh-patrol.svg)](https://github.com/yangpeng366/dsh-patrol/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/yangpeng366/dsh-patrol/verify.yml?branch=main)](https://github.com/yangpeng366/dsh-patrol/actions/workflows/verify.yml)
[![npm](https://img.shields.io/badge/npm-0.1.0-blue)](https://github.com/yangpeng366/dsh-patrol/releases/tag/v0.1.0)

A DeepSeek Harness plugin that turns a **row-based task source** — a 项目方向表 (project direction
table) in 飞书多维表格 (Feishu Bitable) by default, or a local JSON file — into DSH-native work:
read the table, turn each due row into a Trigger, admit it under a versioned Policy, open a Ticket
for what was admitted, dispatch bounded agent work (任务巡检 / patrol round), and write the round's
result back to the table (方向表回写 / write-back).

**面向 agent 的接入**（CLI 参数、item 形状、退出码）见下文「面向 Agent 的接入」与「不做什么」两节。

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
| `巡检间隔(分钟)` | the row's own due rule · `0`/blank = 停跑 ⇒ recorded as `stopped`, never dispatched (Policy v4) |
| `仓库路径` | the Ticket's scope, the working directory, and a probed fact: `exists` / `kind` / `normalizedPath` / `reason` (`repo-exists`, see `docs/policy-v4-triage.md` §6.1) |
| `codex_thread_id` | the session to resume |
| `当前阶段` | the Ticket's stage |
| `外部成就` | where the round's result is appended |
| `待审行动` | the action waiting for a human |

## Install

Install into the host, then enable the bundle in the profile patch — the whole sequence, a
minimal config and the uninstall steps are in [Install & configure](#install--configure).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `kind` | `bitable` | `bitable` or `local-json` |
| `baseToken` / `tableId` | — | the table to read (Bitable) |
| `tasksFile` | — | the JSON file to read (local-json) |
| `identity` | `user` | identity used for the Bitable read |
| `policyVersion` | `v4` | recorded on every Mandate; v3 makes the repo allowlist fail-closed, v4 adds `schedule-stopped` |
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
## CLI（`patrol`）

skill 的前三步——列行、看一行、回写一轮——不依赖 DSH 宿主，装包后直接可用：

```bash
patrol rows
patrol row <record_id>
patrol report <record_id> --stage "已实现" --next "补 CLI 测试" --achievement "做了什么，证据是什么"
```

数据源按 `--source` / `PATROL_SOURCE` 选择：`local-json` 用 `--tasks-file`，`bitable` 用
`--base-token` / `--table-id`（或 `PATROL_BASE_TOKEN` / `PATROL_TABLE_ID`）。`report` 默认把新结果
追加到「外部成就」并标时间，`--replace` 才覆盖；`--achievement -` 从标准输入读，适合贴多行证据；
`--json` 输出机器可读结果。退出码：0 成功，2 参数/配置/行不存在，1 运行期失败。

## 面向 Agent 的接入（Agent integration）

给下游 agent 的接口面，三件事：CLI 怎么调、行数据是什么形状、退出码意味着什么。

**CLI**（源码 `src/cli.ts`，构建产物 `lib/cli.js`，bin 名 `patrol`；`--help` 全文如下）：

```
用法：
  patrol rows [--json]
  patrol row <id> [--json]
  patrol report <id> --stage <阶段> --next <下一行> [--achievement <文本|->] [--thread <id>] [--action-type <kind>] [--replace]

参数：
  --json                        输出机器可读的 JSON
  --replace                     覆盖“外部成就”，默认追加一条带时间的记录
  --action-type <kind>          回写“动作类型”列，只接受 repo-code / repo-test / repo-doc / field-ops / release / secret / config / decision / unclear
                                （大小写与首尾空白会归一化；其它值直接报错，不写表）

数据源（命令行参数优先于环境变量）：
  --source local-json|bitable   PATROL_SOURCE
  --tasks-file <path>           PATROL_TASKS_FILE
  --base-token <token>          PATROL_BASE_TOKEN / BITABLE_BASE_TOKEN
  --table-id <id>               PATROL_TABLE_ID / BITABLE_TABLE_ID
  --identity user|bot           PATROL_IDENTITY
  --lark-cli <path>             LARK_CLI

退出码：0 成功；2 参数、配置或行不存在；1 运行期失败。
```

**行形状（item 契约）**：唯一事实源是 `schemas/item.schema.json`（只在源码仓，不随包分发，由
`tests/contract.spec.ts` / `tests/schema-parity.spec.ts` 校验）；实际读写形状是
`src/source/provider.ts::DirectionItem`，归一由 `normalizeItem()` 完成。必填 `id` / `title` /
`priority`（P0/P1/P2，非法降 P2）/ `intervalMin`（`0` = 停跑，不派发）；常用 `repoPath` /
`nextStep`（空 = 没活）/ `threadId`（续跑会话，空则新建）/ `lastRun`（ISO 时间串，空 = 到期）/
`currentStage` / `achievement`；审批三件套 `authorization`（自主/需审批/只读）/ `collaboration` /
`approval`（已通过才放行）；`userNote` / `contribution` / `actionType` / `pendingAction` /
`category` 等扩展字段归一后原样保留。这份契约与 `patrol-scaffold` 的 item schema 同源。

**换数据源看哪里**：先读 `src/source/provider.ts`（`DirectionItem` + `SourceProvider` —— 只有两个
方法 `listItems()` / `writeBack(id, fields)`，加上 `normalizeItem`），两个现成实现是
`src/source/bitable.ts` / `src/source/local-json.ts`；列名映射在 `docs/001-domain.md`。新数据源只要
实现这两个方法，归一与 schema 校验都是现成的。

## 不做什么（What it does not do）

1. **不负责调度与派发。** `patrol` CLI 只做三件事：列行（`rows`）、看一行（`row`）、回写一轮
   （`report`）。轮次、定时、worker 派发、Ticket 生命周期都在 DSH 宿主内（`roundIntervalMs` +
   dispatcher），CLI 不跑轮、不派活、不设闹钟。
2. **不替用户改表结构，也不猜词表外的取值。** 动作类型只有九种（`src/core/action-vocabulary.ts`），
   `--action-type` 给词表外的写法（`repo_code`、`Repo-Code!`）直接报错退出 2、不写表；列名映射是
   写死的（见上方 column mapping 表），新增列要改源码，不是改配置。
3. **被 Gate 拒绝的行什么都不写。** 只读/需审批、审批状态未通过、停跑（`intervalMin=0`）、repo
   不在白名单、`下一步` 为空——这些行在 Assessment 之前就被拒，不派发也不回写；`observe` 模式下
   整轮不派发也不写回（只记录「本可以放行」）。写回只写非空字段，`--replace` 才覆盖「外部成就」旧值。

失败时：退出码 2 = 参数、配置或行不存在（stderr 打 `patrol: <原因>`）；1 = 运行期失败（网络、
`lark-cli` 不可用等）；任何失败都不会留下写坏一半的表行。

`observe` mode is meant to be run against a live table before anything is allowed to start
(`scripts/` ships only in a clone: a tarball install has no `scripts/` directory — see
[Install & configure](#install--configure)):

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

**Policy v4 reads the row's schedule.** `巡检间隔(分钟)` was the one structured fact v3 never read: in
the 2026-11-10 log, 56 of the 68 would-accept rows carry `0` or a blank cell, which is the table's own
way of writing 停跑 (its `巡检占用` column says `0=禁用巡检` in words). v4 refuses those rows with
`schedule-stopped` before assessment, and refuses a row whose schedule fact is missing for the same
reason v3 refuses an unconfigured allowlist: a forgotten setting is not a permission. `0` no longer
means "every round". A stopped row is also no longer offered to the Gate once an hour just to be refused:
the due filter skips it (`itemIsDue` → `false`), and the round records it as `stopped` with its
`recordId` and the interval the table wrote, so the log still answers "which rows are stopped".
The same version now reads the repo cell as a fact too: `仓库路径` is parsed and
probed (`repo-exists`: one reachable directory, or a named refusal such as `repo-missing`,
`repo-path-ambiguous`, `repo-empty-cell`, `repo-path-unreachable`), and the Gate refuses a row whose
cell proves nothing — including a row with no such fact at all. The 68 rows were classified one by one
— 56 excluded, 10 approval, 2 read-only, 0 auto — in [`docs/policy-v4-triage.md`](docs/policy-v4-triage.md),
which also names the one fact the Gate still cannot get (a structured action type) instead of guessing
it from `下一步` prose. `acceptMode` stays `observe`; v4 only narrows what may enter assessment.

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
`recordId` and the row's own `intervalMin` (with `0` meaning 停跑), `ticketId` (when a Ticket was
opened) and `wouldAccept` (when an accept was held back for review):

```json
{"ts":"2026-11-10T14:33:42.920Z","roundId":"rnd_20261110T010000Z_1","verdict":"observed","reason":"held-by-mode:observe","threadKey":"patrol:rec1","recordId":"rec1","intervalMin":60,"triggerId":"rec1","evalId":"eval_3ff45714ea4c","wouldAccept":{"title":"补齐审计脚本","scope":"D:\\gitAll\\demo","rules":["next-step-present"]}}
{"ts":"2026-11-10T14:33:42.921Z","roundId":"rnd_20261110T010000Z_1","verdict":"stopped","reason":"schedule-stopped","threadKey":"patrol:recStop","recordId":"recStop","intervalMin":0,"triggerId":"trg_recStop_3b1c","evalId":"eval_9f2a0d51c7be"}
```

A `stopped` line is a row whose schedule is stopped: it was not judged, nothing was assessed, nothing
was dispatched — but it is in the log, so "which rows are stopped, and why did nothing run" stays a
query instead of a memory.

Reading it back is what turns `observe` mode into a decision (`scripts/policy-audit.mjs` is also
clone-only, for the same reason):

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
  stopped      1
  ignored      1
  unavailable  1

by reason:
      2  held-by-mode:observe
      1  model-timeout
      1  read-only-direction
      1  schedule-stopped

would-accept (held for review): 2
  #1 2026-11-10T14:33:42.920Z patrol:rec1 verdict=observed reason=held-by-mode:observe
      title: 补齐审计脚本
      scope: D:\gitAll\demo
      rules: next-step-present

stopped rows (recorded, not dispatched): 1
  #3 2026-11-10T14:33:42.921Z recStop 巡检间隔=0 reason=schedule-stopped
```

`--json` emits the same thing as one object (`total`, `badLines`, `verdicts`, `reasons`,
`wouldAccept`, `stopped`), so a digest job can gate on `wouldAccept.length` instead of grepping text.

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

同一行结束之后再开时，第二条 Ticket 的 id 追加 `-r2`、`-r3`……；第一条 `ended` 记录留在
`tickets()` 里，审计能看到几代工作各自的结果，而不是被新记录覆盖。

## 多实例部署约束（multi-instance）

Ticket 只在 `Engine` 的内存里（`ticketStore`），`ticket-already-open` 也只在这个进程内成立；
`decisionLogPath` 是唯一的跨进程痕迹，而它只记录决定、不参与判定。所以同一套方向表**只能有一个实例**
在跑。这不是性能建议，是正确性条件：

- **一仓一实例。** 两个实例读同一张表时，各自看到的 open ticket 都是空集，于是同一行同一条方向会在
  两个进程里各开一张票、各派发一次。闸门本身没问题，它只是看不到另一个进程。
- **多行同仓不能按行分片。** 同一仓的两行会落到不同进程，`ticket-already-open` 同样失效；要并行就按
  **仓**分片，让一个仓的所有行只归一个实例。
- **重启会重开。** Trigger id 是内容寻址的，但去重表也在内存里：进程重启后未改动的行重新成为 pending，
  于是再开一代 ticket（`-r2` 只在旧 ticket 记录还在时出现，重启后又是新的 `tkt_…`）。先 `endTicket`
  再重启，或先用 `observe` 观察一轮再决定。
- **审计按实例分文件。** 两个实例写同一个 `decisionLogPath` 不会把行写坏（一行一次 append），但计数会
  混在一起；每个实例给一个自己的 JSONL，读的时候才有意义。

需要多处同时跑时，用 `tasksFile`／表把一个仓的集合切给一个实例，其余实例换表或停掉。边界仍是单进程：
上面「同仓并发演练」证明的是同一进程内两轮并发的闸门有效，不是多进程互斥。

## Running on Windows

`lark-cli` installs as a shim (`lark-cli.cmd` / `lark-cli.ps1`), which Node cannot spawn by bare
name — the Bitable source goes through `cmd.exe` on Windows and uses the plain binary elsewhere.
Override with `LARK_CLI=/path/to/lark-cli`.

## Install & configure

### What DSH 0.2.1-alpha.2 loads, and from where

This is a **bundle layer**, not a library to `import` by hand. `package.json` declares the DSH
bundle entry — `dsh.bundle.patch` → `./cordis.patch.yml`, `manifestVersion: 1` — and that patch is
what the host reads. It deliberately carries no configuration: `cordis.patch.yml:4-5` says which
table to read, which policy version and where work goes come from the **profile**, not from the
patch. So installing the package is what *loads* the plugin; configuring the profile is what makes
it do work.

The same patch declares the agent preset every worker Session runs under
(`@deepseek-ai/dsh-agent-preset`, id `dsh-patrol-worker`) and the shell / fs / skill tools that
preset needs. Nothing else has to be inserted by hand.

The packaged skill needs no separate install either. DSH's filesystem skill provider only scans
workspaces, so the plugin registers `skills/dsh-patrol/SKILL.md` itself at load time
(`src/index.ts:177-186`; `readPackagedSkill` reads `../skills/<name>/SKILL.md` relative to
`lib/index.js`, `src/skill.ts:30-31`).

### 1. Install the package

Nothing is on a registry yet, so install the tarball this repo builds:

```powershell
pnpm pack --pack-destination .\dist       # runs `prepare` first, so lib/ is built from src/
pnpm add .\dist\dsh-patrol-0.1.0.tgz    # run in the project that hosts DSH
# after the first publish: pnpm add dsh-patrol@0.1.0
```

The peers are supplied by the host, not by this package: `@deepseek-ai/cordis@4.0.5-alpha.1` and
`@deepseek-ai/dsh-agent` / `dsh-session` / `dsh-skill@0.2.1-alpha.2`. Node must satisfy
`^22.19.0 || >=24.0.0`.

### 2. Enable the bundle

```yaml
- insert:
    - id: dsh-patrol
      name: dsh-patrol
```

### 3. A minimal configuration

`local-json` is the shortest path to a real round — no Feishu account, no `lark-cli`. Every key
below is spelled exactly as in the config schema (line numbers are `src/index.ts`):

```yaml
- insert:
    - id: dsh-patrol
      name: dsh-patrol
      config:
        kind: local-json                       # Config.kind            src/index.ts:30
        tasksFile: .artifacts/directions.json  # Config.tasksFile       src/index.ts:36
        autonomousRepos:                       # Config.autonomousRepos src/index.ts:56
          - 'D:\gitAll\dsh-patrol'
        acceptMode: observe                    # Config.acceptMode      src/index.ts:44
        roundIntervalMs: 600000                # Config.roundIntervalMs src/index.ts:63
```

- `kind` / `tasksFile` — the source. `local-json` reads a file holding an array of items, each in
the `schemas/item.schema.json` shape.
- `autonomousRepos` — the allowlist. **Empty refuses, it never widens** (`repo-allowlist-unset`);
a row outside every prefix is `repo-not-autonomous`, refused before assessment.
- `acceptMode: observe` — the default, and where a new install should start: every row is judged,
what *would* be accepted is recorded, no Ticket opens.
- `roundIntervalMs` — how often a round runs; the schema's floor is `1000`. `600000` is 10 minutes.

Worth setting on a first run: `decisionLogPath` (`src/index.ts:49`), which appends one JSONL line
per decision so an `observe` round can be read back instead of guessed.

### 4. `ticket-already-open` is per repo, not per process

A direction table often holds several rows pointing at the same repo, and one row is one thread —
so "one line of work per thread" is not "one line of work per repo". Since v3 the refusal is
decided on the repo: an open Ticket holds its `repoPath`, and a second row for that repo is
`ignored` / `ticket-already-open` (`src/core/policy.ts:119-124`, `holdsRepo` at
`src/core/policy.ts:171-176`). Rows pointing at other repos are untouched. An `ended` Ticket holds
nothing, so the row may open again — with a new generation id `…-r2`, `…-r3`
(`src/core/engine.ts:227-229`), because the ended record is kept. The check runs again against the
current ticket set right before `openTicket()` (`src/core/engine.ts:166`), since the Assessment in
between is awaited.

A Ticket that predates `repoPath` cannot be attributed to a repo, so it blocks its own thread; with
no thread either, it blocks everything. An unattributable open Ticket must never be the hole a
second line opens through.

All of this is single-process, one `Engine` instance: Tickets live in memory, so two hosts running
the same table share nothing. Run one instance per repo set.

### 5. What is in the tarball, and what is not

`files` ships `lib/`, `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `docs/` and `skills/` (plus
`LICENSE` and `package.json`, which npm/pnpm always include). `src/`, `tests/`, `schemas/` and
`scripts/` stay in the source repo:

- `schemas/item.schema.json` exists **only in the source repo**, for contract validation: it is
read by `tests/contract.spec.ts` and `tests/schema-parity.spec.ts`, never by `lib/index.js`, whose
only file read is `../skills/<name>/SKILL.md` (`lib/index.js:886`).
- `scripts/` holds maintainer tools (`shadow-run.mjs`, `policy-audit.mjs`, `same-repo-rehearsal.ts`).
A packaged install has no `scripts/` directory, so run them from a clone.

### 6. Uninstall

1. Remove the `dsh-patrol` insert from the profile patch and restart DSH. Unloading clears the
interval and awaits the round in flight, so no write-back is lost half way
(`src/index.ts:206-210`); the `dsh-patrol-worker` preset is part of the same layer and goes with it.
2. `pnpm remove dsh-patrol` in the host project.
3. Nothing else is left behind except files you asked for: the `decisionLogPath` JSONL — delete it
if you no longer want the history. Tickets live in memory only, so a restart starts empty.

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run — 191 tests
pnpm build       # tsdown
```

Current state: typecheck clean, 191 tests pass, build produces `lib/index.js` + `lib/index.d.ts`.

CI runs these four steps on every push to `main` and every pull request, on a clean `ubuntu-latest`
runner with Node 22 (`.github/workflows/verify.yml`): `pnpm install --frozen-lockfile`, then
`pnpm typecheck`, then `pnpm test`, then `node scripts/release-check.mjs`. There is no
`continue-on-error` and no platform skip, so a red step there is a red clone.

One command runs all three and then judges the artifact itself (`scripts/` is clone-only, so this is
for a clone, not for an install):

```bash
node scripts/release-check.mjs        # 0 = PASS, 1 = a named check failed, 2 = usage error
```

It verifies: the three gates above pass; `pnpm pack` into the system temp directory produces exactly
one tarball and leaves none in the repo; the tarball contains `package/package.json`,
`package/lib/index.js`, `package/lib/index.d.ts`, `package/lib/cli.js`, `package/cordis.patch.yml`,
`package/README.md`, `package/CHANGELOG.md` and `package/skills/dsh-patrol/SKILL.md`; it contains
none of `package/src/`, `package/tests/`, `package/scripts/`, `package/schemas/`, `node_modules`, or
archive/log/temp residue; `lib/cli.js` starts from the *unpacked* tarball with no repo
`node_modules` on the resolution path — run as `--help` and as a real `rows` read, and checked
statically to import only `node:` builtins and its own chunk; and `package.json.version` is the
newest `## [x.y.z]` heading in `CHANGELOG.md`. It prints the tarball's SHA256, byte count and file
count, then one `RESULT: PASS` line and one line of JSON; a failure exits non-zero and names the
check (`content:required`, `content:forbidden`, `cli:help`, `version:changelog`, …). `--keep-temp`
keeps the pack and unpack directory for triage; the temp directory is removed otherwise.

What it does **not** verify: installing the tarball into a DSH host (the live-host run below is the
evidence for that), the Bitable/`lark-cli` network path, the presence of the DSH peer packages, or
runtime behaviour against a real direction table. It also does not publish, tag or commit anything —
the tarball it builds lives in the temp directory and is thrown away.

What the tests actually pin down: the Gate's refusals (needs-approval, read-only, approval state,
no next step, ticket already open, paused), the v3 repo default (empty allowlist refuses, explicit
`allowAnyRepo` is the only way back, prefix hit/miss and case/separator normalisation, the repo
layer staying ahead of the ticket layer), Mandate re-validation across a policy change,
`observe`/`off` holding verdicts back, duplicate-trigger idempotency, content-addressed trigger
ids, the row interval, the Bitable column mapping, and a round that survives a failing write-back —
plus the host source's local-json write-back, which must keep the row's own `下一步` untouched.
The decision log adds: one line per decision with no BOM and no truncation, a created directory, a
blocked write that is reported rather than thrown, the empty `decisionLogPath` that writes nothing,
and the audit script's counts, bad-line line numbers and `wouldAccept` filter (run as the real CLI).
The same-repo rehearsal adds: one open ticket per repo across five Engine-path scenarios, including
two rounds launched without an intervening `await` (the Assessor windows are asserted to overlap),
and a repo layer that refuses every row outside the allowlist before the ticket layer runs.

**Verified on a live host** — DSH `0.2.1-alpha.2` on Windows, 2026-11-11. The tarball was installed
into an isolated profile (`dsh plugin --profile patrol-web add ./dsh-patrol-0.1.0.tgz`), the bundle
patch mounted, and one `local-json` round ran with `acceptMode: auto` and `dispatcher: log`: `apply()`
executed, the host's skill registry reported `dsh-patrol` (`source: runtime`, 1457-byte body, resource
base inside the installed package), exactly one Ticket was opened, and the row was written back. What
is **not** verified: the `dsh` dispatcher against a real `sessionController` (that service ships in
`@deepseek-ai/dsh-api-session-controller`, which a 0.2.1-alpha.2 install does not carry) and the
bundled worker preset (its `agentPresets` service is absent from the headless and web bundles, so the
preset row stays `pending`; it holds no code this plugin needs). `sessionController` is resolved
lazily in `createDispatcher` and deliberately **not** in `inject`: requiring it kept the whole plugin
`pending (waiting for service: sessionController)` on that host — no round, no skill, no ticket. The
DSH seam stays narrow — `DshSessionController.prompt` is declared structurally in `src/dispatch.ts` —
so a DSH upgrade changes one file rather than the engine. The `codex` and `log` dispatchers need no
DSH host at all.

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
