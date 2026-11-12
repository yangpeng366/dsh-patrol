# 更新日志

本仓所有值得记录的变更都写在这里。格式参照
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)；日期为发布日（`YYYY-MM-DD`）。

条目只写已经落进代码、并有过测试或演练证据的行为；计划中的能力不进本文件。
每条末尾的短哈希指向本仓提交，便于回溯。

## [Unreleased]

### Added

- 结构化「动作类型」列：`DirectionItem.actionType`（可选）+ `BitableSource` 读取方向表同名列（列不存在或
  单元格为空 ⇒ `undefined`，不报错）。`inspectAction()` 先读这一列：合法值就是 `kind`，`source='column'`，
  词表不再改判（`下一步` 写「发版」也不改）；列缺失/为空才退回词表，`source='text'`，并在 `reason` 里
  写明「列值为空，已退回词表推断」；列值大小写与首尾空白容错，**非法值判 `unclear`**（不退回词表，
  否则打错字会被重新读成 `repo-code`）。`ActionFacts.source` 是新的可读标记，决策日志每行带 `actionSource`，
  `scripts/policy-triage-check.mjs` 的 `action:counts` 分别报 `source-column` / `source-text` 两个数。
  `itemFingerprint()` 纳入 `actionType`：列值被写入或改正会生成新 Trigger，列缺失时 id 与之前完全一致。
  `acceptMode` 仍为 `observe`，`auto` 仍为 0；方向表实际回填前，78 行仍是 `source-text`（`source-column=0`）。

- Policy `v4`：新增 `schedule-stopped`。`巡检间隔(分钟)` 作为结构化事实进入 `DirectionFacts`，
  `0`/空（表内约定即停跑，`巡检占用` 列写明 `0=禁用巡检`）在 Gate 第一道行级检查被拒；
  事实缺失同样拒绝（与 v3 的 `repo-allowlist-unset` 同一条理由）。`0` 不再被读成“每轮”。
  `Config.policyVersion` 默认从 `v3` 升到 `v4`；`inferredRules` 未放宽，`acceptMode` 仍为 `observe`。
- `docs/policy-v4-triage.md`：2026-11-10 那 68 条 would-accept 的逐条定性（excluded 56 / approval 10 /
  read-only 2 / auto 0）、判定口径与代码落点的对应、日志/表不一致、以及 Policy 仍未拿到的
  事实清单（`repo-exists`、动作类型、纯路径列）。
- `scripts/policy-triage-check.mjs` + `tests/policy-triage-check.spec.ts`：用同一份日志与方向表
  重算逐条表的覆盖、词表、可结构化的口径与 `triage-summary` 计数，文档与数据一处不一致即非零退出。
- `repo-exists`（Policy v4 补齐的仓库事实）：`src/core/repo-facts.ts` 把方向表 `仓库路径` 的**原始单元格**
  读成 `exists / kind / normalizedPath / reason / candidates`，处理目录、文件、相对路径、空值、多行/多路径、
  Windows 路径与带说明文字的单元格；拿不准就 fail-closed（`repo-path-ambiguous`、`repo-path-relative-unresolved`、
  `repo-path-unreachable` 各自成词，不与 `repo-missing` 混用）。`DirectionFacts.repoExists` 承载该事实，
  Gate 在仓库白名单之后读它：`reason !== 'repo-exists-ok'` 即拒，缺事实报 `repo-exists-unknown`。
- `scripts/policy-triage-check.mjs` 新增 `repo:table` / `repo:counts` / `repo:tally`：用 Gate 自己的
  `inspectRepoPath()` 重算 `docs/policy-v4-triage.md` §6.1 的 8 条候选与 §5 的 68 条分档，
  文档、机器可读块与探测结果三处必须一致。

- `action-type`（Policy v4 补齐的动作类型事实）：`src/core/action-facts.ts` 把方向表的 `下一步` /
  `简要描述` / `用户批注` / `授权边界` / `贡献类型` / `审批状态` 读成
  `kind / matched / evidence / field / reason / alternatives`，判定 `repo-code` / `repo-test` /
  `repo-doc` / `field-ops` / `release` / `secret` / `config` / `decision` / `unclear`。准入只认
  `下一步`，拒绝可来自任何一格，最严者胜，无证据即 `unclear`（绝不默认 `repo-code`）。
  `DirectionFacts.actionFacts` 承载该事实，Gate 在仓库层之后读它：非仓内 kind 各有独立理由
  （`action-field-ops` / `action-release` / `action-needs-secret` / `action-needs-config` /
  `action-needs-decision`），缺事实报 `action-facts-unknown`，事实自相矛盾报 `action-unclear`。
  `acceptMode` 仍为 `observe`，`auto` 仍为 0。
- `scripts/policy-triage-check.mjs` 新增 `action:counts`：用 Gate 自己的 `inspectAction()` 重算方向表
  78 行的动作类型，与 `docs/policy-v4-triage.md` §6.2 的 `triage-action` 块逐项核对
  （unclear 19 / secret 12 / decision 11 / field-ops 10 / release 10 / repo-code 9 / repo-doc 3 /
  repo-test 2 / config 2）；文档块缺失或与表不符即非零退出。
- `docs/policy-v4-triage.md` 新增 §6.2：动作类型的字段、准入与拒绝的不对称规则、78 行实测与残余风险
  （词表会漏判，彻底消除仍需方向表新增结构化「动作类型」列，本模块届时降级为该列的预填工具）。

### Changed

- 停跑决策日志改为集合状态机：首轮写 `stoppedEvent="snapshot"` 全量（每行仍是 `verdict="stopped"` /
  `reason="schedule-stopped"`，Policy v4 语义不变），之后只在新增停跑行写 `added`、恢复运行写
  `removed`、集合不变且达到 `stoppedHeartbeatMs`（默认 12 小时）时写一条 `heartbeat`；每条带
  `stoppedCount` 与按 `recordId` 排序的 `recordId + intervalMin` SHA-256 指纹。心跳按真实时间而非
  轮数计，避免 `roundIntervalMs` 改变后新鲜度漂移。`scripts/policy-audit.mjs` 重放
  `snapshot / added / removed / heartbeat`，一次列出当前停跑行，并额外输出 `stoppedState`；旧日志
  无 `stoppedEvent` 的行仍兼容读取。`stoppedState` 增加两项核对：`heartbeatMatches`（最新心跳
  指纹与回放集合是否一致）与 `orphanRemovals`（无对应加入行的移除，提示日志被轮转或截断）。行级事件另带 `stoppedSince`（本进程首见停跑时刻），供回答
  「这行停了多久」；重启后快照会把存活行重基到快照时刻，故它是下界而非历史真值。
- `DirectionPolicy.refuseAction()` 接受来自 `动作类型` 列的仓内 kind：列值没有命中词（`matched` 为空）
  仍然放行，但要求 `source='column'` 且 `field='动作类型'` 且 `evidence` 非空；声称来自列却不带内容的事实
  仍是 `action-unclear`。词表推的 `repo-code` 缺 `matched` 依旧被拒。
- `itemFingerprint()` 纳入 `intervalMin`：停跑→恢复会生成新 Trigger，否则恢复的行永远被判为重复事件。
- `itemFingerprint()` 纳入仓库存在性（`exists` / `missing`）：仓被克隆回来后重新判定，而不是被当成重复事件。
- `DirectionPolicy.gate()` 的仓库层变成两步：白名单（`repo-allowlist-unset` / `no-repo-path` /
  `repo-not-cloned` / `repo-not-autonomous`）→ 存在性（`repo-exists-*`）。仍保持 `observe`，没有任何行切到 auto。
- `itemIsDue()` 不再把 `0`（停跑）当 60 分钟：`interval <= 0` 返回 `false`，停跑行不再每轮进 `runRound()`
  被 Gate 拒一次。可见性没有跟着丢：`PatrolRunner.runOnce()` 把停跑行作为 `stopped` 触发集交给同一轮，
  `Engine.runRound(now, { stopped })` 把停跑行记成 `verdict: "stopped"` / `reason: "schedule-stopped"`
  （`recordId` + `intervalMin` 原值，`RoundSummary.stopped` 计数；记录时机见上方状态机），不调 Assessor、不开 Ticket；
  `evaluated` 只数真正判过的行。决策日志行同时新增 `recordId` / `intervalMin`。`Policy.gate()` 语义与
  reason 一字未动。`docs/policy-v4-triage.md` §6.3 / §9.1 记录口径与一轮 78 行实测（66 stopped / 12 进 Gate /
  0 次 Assessment），`scripts/policy-audit.mjs` 新增 `stopped` 列表与计数。
- `patrol row <id>` 的 `巡检间隔` 显示改为 `停跑（0/空）`，不再写“每轮”。
- `scripts/release-check.mjs`：发布前一条命令完成 `pnpm typecheck` / `test` / `build`、`pnpm pack`
  到系统临时目录、tarball 必需内容（`package.json`、`lib/index.js`、`lib/index.d.ts`、`lib/cli.js`、
  `cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`skills/dsh-patrol/SKILL.md`）与禁入内容
  （`src/`、`tests/`、`scripts/`、`schemas/`、`node_modules`、压缩/日志/临时残留）的校验，并从解包目录
  真实启动 `lib/cli.js`，最后核对 `package.json.version` 等于 `CHANGELOG.md` 最新 `## [x.y.z]`。
  通过时打印 `RESULT: PASS` 与一行 JSON（含 tarball SHA256、字节数、文件数），失败非零退出并指出
  具体检查项；临时目录无论成败都清理（`--keep-temp` 可保留）。不发布、不改 registry、不打 tag。
- README 的 Verification 段补上这条命令，并写清它验证什么、不验证什么。

## [0.1.0] - 2026-11-11

首个可安装版本。Policy 版本为 `v3`，仓库白名单默认拒绝（fail-closed）。

### Added

- 配置项 `allowAnyRepo`（默认 `false`）：唯一能回到 v3 之前「任意仓库」规则的开关，
  不会被「`autonomousRepos` 为空」隐式打开（`src/index.ts:61`，`d077529`）。
- `Ticket.repoPath`：Ticket 记下它是为哪个仓库开的，`ticket-already-open` 才能按仓判定，
  而不再按「进程内有任意 open ticket」判定（`src/core/model.ts:84`，`fc36f15`）。
- `docs/policy-v3-allowlist.md`：v3 白名单的口径、16 条 would-accept 行的逐条归类、
  前缀比较规则，以及同仓并发演练的细则（`d077529`、`fc36f15`）。
- `scripts/same-repo-rehearsal.ts`：走 Engine 真实路径（`runRound()` → `Policy.gate()` →
- `patrol` 命令行（`bin`）：`rows` / `row <id>` / `report <id>` 三个命令，直接使用 `SourceProvider`
  契约；`report` 默认给「外部成就」追加带时间的结果，`--replace` 才覆盖。`local-json` 源新增可写变体
  `LocalJsonFileSource`，无飞书账号也能把一轮完整走完。
  `Assessor.assess()` → `openTicket()` → sink）的五个同仓场景演练，全 PASS 退出码 0
  （`fc36f15`）。
- `scripts/shadow-run.mjs --any-repo`：诊断用的显式 opt-in，脚本自己打印
  `[allowAnyRepo: diagnostic opt-in]`；默认仍然按 v3 拒绝（`d077529`）。

### Changed

- `policyVersion` 默认值由 `v1` 改为 `v3`：未写这一项的存量配置升级后按 v3 口径判定，
  每个 Mandate 仍然记录它被授予时的版本（`src/index.ts:40`，`d077529`）。
- `autonomousRepos` 为空不再是「不限制仓库」，而是 `repo-allowlist-unset`：empty 是遗忘
  配置的样子，把它读成「全部允许」正是 v3 要去掉的 fail-open 默认（`src/core/policy.ts:153-156`，`d077529`）。
- `ticket-already-open` 从「进程内任意 open ticket」收紧为「同一仓的 open ticket」；
  指向其它仓的行不再被无关的 open ticket 挡住（`src/core/policy.ts:171-180`，`fc36f15`）。
- `openTicket()` 之前用**当前** ticket 集合重新过闸：`Assessor.assess()` 是 `await`，
  不重检的话两轮可以同时过闸再各自开票（`src/core/engine.ts:166`，`fc36f15`）。
- 已被判定的 Trigger 在下一轮循环里跳过，避免同一轮内对同一 Trigger 二次判定
  （`src/core/engine.ts:124`，`fc36f15`）。
- 同一行在其 Ticket `ended` 之后再次开票时，新 Ticket id 追加 `-r2`、`-r3`……
  （`src/core/engine.ts:227-229`，`26bbe2c`）。
- `scripts/shadow-run.mjs` 的 `--policy` 默认值改为 `v3-shadow`，并打印 v3 下空白名单的
  真实含义（`d077529`）。

### Fixed

- 同一行在 Ticket 结束后再次被受理时，`openTicket()` 会用同一个 id 覆写上一代 Ticket 的记录，
  审计里只剩最后一次工作；现在保留 `ended` 记录并给新工作递增的 id（`26bbe2c`）。
- 两轮并发时同一 Trigger 被判两次、第二次仍按 `pending` 处理的问题（`src/core/engine.ts:124`，`fc36f15`）。

### Security

- **Fail-closed 仓库白名单**：`autonomousRepos` 未配置时，每一条无人值守的行都在 Assessment
  之前被拒（`repo-allowlist-unset`），而不是悄悄放到全仓；`allowAnyRepo` 必须由调用方显式写出
  （`src/core/policy.ts:153-156`，`d077529`）。
- **开票前重过闸（TOCTOU）**：Assessment 期间 ticket 集合可能已变，`openTicket()` 前用当次集合
  重跑 Gate，中间无 `await`，两轮抢同一个仓不会各开一张票（`src/core/engine.ts:166`，`fc36f15`）。
- **不可归因的 open Ticket 不得成为缺口**：早期没有 `repoPath` 的 open ticket 无法归属仓库时，
  它挡住自己所属的 thread；连 thread 都没有时挡住一切（`src/core/policy.ts:171-180`，`fc36f15`）。
- **一行两代可审计**：Ticket 记录不被覆写，几代工作各自的结果都留在 `tickets()` 里（`26bbe2c`）。

## 版本对照

| 版本 | 日期 | Policy 默认 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-11-11 | `v3` | 首个可安装版本：失败即拒的仓库白名单、按仓的 `ticket-already-open`、多代 Ticket 保留 |
