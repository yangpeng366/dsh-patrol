# `仓库路径` 单元格体检：哪一格还不是「纯路径」

日期：2026-11-17 · 适用版本：`policyVersion: v4` · 实测快照：`rev 4419`（`tbl2XGd8bO10NBY5_20261111_075800_4419.ndjson`，78 行）

## 1. 为什么需要它

方向表的 `仓库路径` 是自由文本，实际共存三种形状：

| 形状 | 例子 | 白名单能按它匹配吗 |
| --- | --- | --- |
| 裸路径 | `D:\gitAll\mpd` | 能 |
| 路径 + 注记 | `E:\gitAll\openeyes（门禁…）` | 不能（按格匹配会把注记算进仓名） |
| 一格多仓 | `D:\gitAll\mpd + D:\gitAll\mpd-front`（或 `;` 分隔的四路来源） | 不能（一格不是一仓） |

Gate 已经对后两种 fail-closed（`repo-path-ambiguous`），但「还有哪几格没干净」长期靠眼看；
方向表里「建一个纯路径列」的诉求也因此没有可复核的进度。这个脚本把那一列需要的数据变成一条命令：
用 Gate 自己的 `inspectRepoPath()` + 真实文件系统，逐行给出 `pure / normalized / offender`。

它只读：不写表、不派发、除 `statSync` 外不碰任何东西。

## 2. 用法

```powershell
node scripts/repo-cell-audit.mjs                    # 默认取 .artifacts/direction 下最新 ndjson
node scripts/repo-cell-audit.mjs --file <dump.ndjson>
node scripts/repo-cell-audit.mjs --file <dump.ndjson> --json
node scripts/repo-cell-audit.mjs --file <dump.ndjson> --strict   # 任一格不是单一目录即退出 1
```

退出码：`0` 体检跑完（`--strict` 时表示全干净） · `1` `--strict` 下存在 offender · `2` 用法错误或读不到文件。

三种状态的判据：

- `pure`：单元格文本与 `normalizedPath` **逐字节相同**（`D:\gitAll\mpd`）
- `normalized`：确实指向唯一目录，但文本需要整理（`D:/gitAll/x`、`d:\gitAll\x\`）。只有分隔符与盘符大小写会被折叠，注记永不折叠
- `offender`：没有唯一可证目录——空、多仓、带注记、文件、缺失、未克隆、相对路径，各自保留自己的 `reason`

## 3. rev 4419 实测

```powershell
node scripts/repo-cell-audit.mjs --file .artifacts/direction/tbl2XGd8bO10NBY5_20261111_075800_4419.ndjson
```

```
rows=78  pure=60  normalized=0  offenders=18
   60  repo-exists-ok
    9  repo-empty-cell
    3  repo-missing
    2  repo-not-cloned
    2  repo-path-ambiguous
    1  repo-path-relative-unresolved
    1  repo-not-a-directory
```

两格 `repo-path-ambiguous` 就是「一格写多仓」的全部存量：

- `reczz28QlJEjtOYY` MPD App OA登录页：`D:\gitAll\mpd + D:\gitAll\mpd-front`（两个目录都真实存在）
- `reczz28Wyptt06nD` OpenEyes / 鼠标集群方向：四路来源用 `;` 分隔且每路带标签
  （`OpenEyes: E:\gitAll\openeyes; agent-desktop (GitCode): …`），解析器把标签当路径，故为 `unresolved` 候选

结论：**「纯路径」列要表达的，就是 `pure=60 / offenders=18` 这组数**。真正需要人要动手的是 18 格，
其中 2 格是结构性的（多仓），9 格是空值，其余 7 格是缺失/未克隆/文件/相对路径——不是同一类问题，
不能靠一列一次解决。列结构属于表体改动，按巡检纪律只能走审批提案，不在脚本里动。

## 4. 与白名单的关系（实测：零行受影响）

`refuseRepo()` 目前按**单元格文本**做前缀匹配。快照里 60 个 `repo-exists-ok` 的单元格文本与
`normalizedPath` 完全相同（`normalized=0`），另外 18 格无论按格还是按仓都不可能命中白名单——
所以「白名单按仓匹配而不是按格匹配」在当前数据上没有第二行会改判，只有拒绝理由的措辞差异。
本轮不动 Gate：改理由会连带动 `docs/policy-v4-triage.md` 的已发布计数，收益与风险不成比例。
等「纯路径」列或单元格整理把 `normalized` 变成非零，再按仓匹配才有意义。

## 5. 验证

```powershell
npx tsc --noEmit                                        # clean
npx vitest run tests/repo-cell-audit.spec.ts            # 13 passed
npx vitest run                                          # 263 passed (20 files)
```

`tests/repo-cell-audit.spec.ts` 分两半：单元侧注入假的 `inspectRepoPath()` 断言三种状态与
`--strict` 语义；CLI 侧用临时目录 + 真实两仓单元格跑真脚本，断言退出码 0/1/2 与 JSON 输出——
脚本的用法说明与真实行为必须一致，否则文档又会先腐烂。
