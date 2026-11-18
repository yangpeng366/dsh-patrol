# local-json 一轮：ignored 里有多少是被仓库事实挡住的

`scripts/local-json-round.ts` 跑**一轮** Policy（`Engine` + `DirectionPolicy`，`acceptMode=observe`），
把 `ignored` 按理由拆开，并单独算「被仓库事实挡住」占 `ignored` 的比例。

存在的理由只有一个：observe 模式是为了开闸前攒决策历史，而这份历史要回答的不是「挡了多少行」，
而是「**是什么在挡**」。仓库层是候选答案里最大的一块，且有两种人改法完全不同的形状——
一格解析不出唯一目录（`repo-path-ambiguous`）和目录根本不在（`repo-missing`）。这个脚本把这两种
从其它拒绝理由里切出来，单独报占比。

## 跑法

```bash
node scripts/local-json-round.ts --dump                       # .artifacts/direction 下最新的一份表转储
node scripts/local-json-round.ts --dump <dump.ndjson> --any-repo
node scripts/local-json-round.ts --tasks-file tests/fixtures/items.json --repos 'D:\gitAll;E:\gitAll'
node scripts/local-json-round.ts --dump --any-repo --json      # 机器可读，带逐行 decisions
```

- 读的是**源**，不是转储阅读器：转储先按 `BitableSource` 的列映射转成本地 JSON（落在
  `.artifacts/local-json/<dump>.json`），再由 `LocalJsonSource` 读回来，所以 Gate 看到的事实和真跑
  一轮 local-json 时一致。多段的 `仓库路径` 单元格只取第一段（与 bitable 源一致），丢失段数会在报告头上注明。
- **`--any-repo` 是诊断开关**，不是默认：关掉 allowlist 层（pre-v3 规则），只量仓库事实层。
  不写它且不配 `--repos`，每一行都会先被 `repo-allowlist-unset` 拒掉，仓库事实一层根本轮不到——
  实测那一轮的 `repo-fact share` 是 `0/12 = 0%`，看上去「仓库没问题」，其实是一行都没被探过。
- 不派发（Ticket 只报不启），不回写（`LocalJsonSource` 是只读类）。`--accept-mode auto` 只是留给
  别的调用方，脚本自己默认 observe。

## 2026-11-19 实测（表 rev 4419，`tbl2XGd8bO10NBY5_20261111_075800_4419`）

```
rows=78  due=12  stopped=66  not-due=0
evaluated=12  observed=0  ignored=12  admitted=0  unavailable=0  tickets=0
repo-fact blocked = 1/12 ignored = 8.3%  (ambiguous 0 = 0%, missing 0 = 0%, other 1 = 8.3%)
```

| 层 | 行数 | 占 ignored |
|---|---|---|
| 仓库事实（合计） | 1 | 8.3% |
| ├ `repo-path-ambiguous` | 0 | 0% |
| ├ `repo-missing` | 0 | 0% |
| └ 其它仓库事实（`repo-not-cloned` `recvwuSTYb28w0`） | 1 | 8.3% |
| 动作层（合计） | 11 | 91.7% |

动作层明细：`action-needs-secret 4`、`action-release 3`、`action-needs-decision 2`、
`action-field-ops 1`、`action-unclear 1`。

三条需要一起读的结论：

1. **仓库事实不是这轮的主要阻挡，动作层是。** Gate 的顺序是 排期 → 审批 → 授权 → 下一步 →
   allowlist → 仓库存在性 → 动作，被动作层拒的行已经过了仓库层；所以这 11 行是「仓库都在盘上、
   下一步却是在无人值守轮里不能做的事」。想把这轮从 `observed=0` 抬起来，先看动作层的 11 行，
   而不是先去做纯路径列。
2. **`ambiguous = 0` 不等于「没有歧义格子」。** 表级只有 2 格 `repo-path-ambiguous`
   （`reczz28QlJEjtOYY` 的 `mpd + mpd-front`、`reczz28Wyptt06nD` 的四路标签来源），这两行的
   `巡检间隔(分钟)` 都是 0/空——它们是停跑行，排期一开头就被挡在 Gate 之前，永远进不了本轮的
   `ignored`。表级仓库事实 offender 是 18/78（`repo-cell-audit` 同口径），但其中能影响一轮实跑的只有进入
   due 集的那几行。
3. **`observed=0` 是本轮最该记住的数字**：observe 模式攒不到任何观察样本，闸就没有依据开。
   78 行里 66 行停跑，剩 12 行全被拒——这不是「策略太严」的单一问题，是「行本身不打算跑」的
   结构与「跑起来的行做的事不适合无人值守」叠加。

## 与其它脚本的分工

| 脚本 | 回答的问题 | 是否判行 |
|---|---|---|
| `repo-cell-audit.mjs` | 表级：`仓库路径` 每格是什么状态、人要做哪一步 | 否（只看格） |
| `policy-audit.mjs` | 历史：决策日志里都拒了什么、停跑行有哪些 | 否（读日志） |
| `local-json-round.ts` | 当下：这一轮 due 行里，仓库事实占 `ignored` 多少 | 是（真跑 Gate） |
| `shadow-run.mjs` | 同上，但直连 Bitable 源、需要 lark 身份 | 是 |

## 退出码

`0` 跑完（不问结果好坏）；`2` 参数错或输入读不了。
