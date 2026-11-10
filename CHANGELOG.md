# 更新日志

本仓所有值得记录的变更都写在这里。格式参照
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)；日期为发布日（`YYYY-MM-DD`）。

条目只写已经落进代码、并有过测试或演练证据的行为；计划中的能力不进本文件。
每条末尾的短哈希指向本仓提交，便于回溯。

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
