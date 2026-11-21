# C 类拆行提案：把「两个活装在一格」的两行切开（不建行）

日期：2026-11-21 · 适用版本：`policyVersion: v4` · 实测快照：`rev 4419`（`tbl2XGd8bO10NBY5_20261111_075800_4419.ndjson`，78 行）

这份文档是**提案**，不是执行记录：两行 C 类各拆成「仓内半行 + 等人半行」，字段值直接写成可以照抄进表的样子，
但**没有在表里建任何行、没有改任何格**。拆行是改表结构，按巡检纪律走审批。

配套读数由仓内脚本现跑，不是推的：

```powershell
node scripts/rewrite-rehearsal.ts     # 改写演练 + 拆行提案两节
node scripts/scope-audit.ts           # 仓库路径 vs 动作目录
```

## 1. 为什么是这两行

`docs/local-json-round.md` 的三类分法里，C 类 3 行「夹带可执行动作」，上一轮把 3 行都拿去演练改写，
结论是：**改写 `下一步` 只翻得动 1 行**。

| record | 改写能翻吗 | 还差什么 | 本轮处理 |
| --- | --- | --- | --- |
| `reczz28QOfrbeaIn` | 词表翻成 `repo-code`，列写死 `release` | 改 `动作类型` 格 + 仓库路径指向 `D:\_codex-control` | **不拆**（一件事，只是仓写错） |
| `recvuOzY5dp9MR` | 翻不动：历史「待批三问」把它钉在 `decision` | 一格装「扫窗口 / 写笔记 / 凭证轮换」三件 | **拆两行**（本文件 §2） |
| `reczz28SSxObE9Ec` | 翻不动：搬走的那半句自带「拍板」 | 一格装「现场日志 / 单测 / 跨仓登出」三件 | **拆两行**（本文件 §3） |

所以拆行只针对后两行：它们不是「句子写得不好」，是「一个格子里装着两种归属」。

## 2. 提案一：`recvuOzY5dp9MR` session-memory-curator

原行（节选）：`下一步` =「扫 11-03 白天窗口出候选；若 A/B/C 仍未批复，则把 R75 遗留 4 条事实升级为
1 篇 note + MEMORY 行（ActiveMQ 凭证优先）」· `动作类型` = `secret` · `巡检间隔` = 720 · `仓库路径` = vault。

### 2.1 仓内半行（新建行 A，可无人值守跑）

| 字段 | 建议值 |
| --- | --- |
| 项目名 | `session-memory-curator｜仓内半行：R75 事实落笔记` |
| 下一步 | `把 R75 遗留的 4 条事实整理成 1 篇笔记写进 vault，并在 MEMORY.md 补一行索引` |
| 动作类型 | `repo-doc` |
| 巡检间隔(分钟) | `720` |
| 仓库路径 | `D:\BaiduSyncdisk\Obsidian Vault\当前项目` |
| 用户批注 | `由 recvuOzY5dp9MR 拆出（2026-11-21）：只保留可独立完成的写作部分；A/B/C 三问与 curator 策略调整留在拆出的另一行。` |
| 父记录 | `recvuOzY5dp9MR` |
| 其余 | 分类 / 优先级 / 协作形态 / 授权边界 与原行相同 |

### 2.2 等人半行（原行改写，停跑）

| 字段 | 建议值 |
| --- | --- |
| 项目名 | `session-memory-curator｜等人半行：A/B/C 批复与 curator 策略` |
| 下一步 | `扫 11-03 白天窗口出候选；若 A/B/C 仍未批复，则按批复结果执行 skills 30→10 合并与 MEMORY 取外置档位；ActiveMQ 凭证的轮换由人做` |
| 动作类型 | 留空（这一行不派工；等批复后再填） |
| 巡检间隔(分钟) | `0` |
| 仓库路径 | 原值不变 |
| 用户批注 | 保留 2026-09-14 curator thread 决策 + 2026-10-31 待批三问原文（这三问是这半行存在的理由，搬走就丢了上下文） |

## 3. 提案二：`reczz28SSxObE9Ec` 多媒体-登出串号

原行（节选）：4 条并列——现场导 pod 日志、`applyTokenSite` 补单测、待拍板的跨仓登出、复测口径。
`动作类型` = `secret` · `巡检间隔` = 1440 · `仓库路径` = `E:\repos\gitAll\articleeditor-tmp`。

### 3.1 仓内半行（新建行 B，可无人值守跑）

| 字段 | 建议值 |
| --- | --- |
| 项目名 | `多媒体-登出串号｜仓内半行：applyTokenSite 单测` |
| 下一步 | `为 applyTokenSite 的站点覆盖逻辑补一条单测用例（E:\repos\gitAll\articleeditor-tmp 的 TokenSiteResolver 已有自检，这回覆盖请求头站点分支）` |
| 动作类型 | `repo-test` |
| 巡检间隔(分钟) | `1440` |
| 仓库路径 | `E:\repos\gitAll\articleeditor-tmp` |
| 用户批注 | `由 reczz28SSxObE9Ec 拆出（2026-11-21）：只保留本仓可独立完成的测试补充；其余部分在拆出的另一行。` |
| 父记录 | `reczz28SSxObE9Ec` |

`applyTokenSite` 的实现在该仓 `base/security/src/main/java/...HiveAuthServiceImpl.java`，已有自检
`TokenSiteResolverSelfTest.java`（`git -C E:\repos\gitAll\articleeditor-tmp grep -l applyTokenSite` 实测 6 个文件命中），
所以这一半确实落在它自己声明的仓里。

### 3.2 等人半行（原行改写，停跑）

| 字段 | 建议值 |
| --- | --- |
| 项目名 | `多媒体-登出串号｜等人半行：pod 日志与跨仓登出` |
| 下一步 | `现场导一次退出时刻的 articleeditor pod 全量日志，核对 sc_frame.sys_config 里 sc-articleeditor-web 的 param.logout 登记；恢复 frame 门户退出时的批量子系统登出仍需用户拍板（ui-frame/src/layouts/SecurityLayout.jsx + models/login.js）；复测须在退出后 ≥40 秒再判定` |
| 动作类型 | 留空 |
| 巡检间隔(分钟) | `0` |
| 仓库路径 | 留空——这一步真正的仓是 `ui-frame`，本地路径不在表内；填 `articleeditor-tmp` 是错的，留空让 Gate 先拒（`repo-empty-cell`）比填错仓诚实 |
| 用户批注 | `认证中心登出通知是异步的（实测 5.4s/10.4s，45 本轮 5.6s，历史 11~32s），窗口内旧会话仍有效。` |

## 4. 实测：拆出来的四个半行各自被读成什么

```powershell
node scripts/rewrite-rehearsal.ts
```

```
--- split proposals (no row is created by this script) ---

recvuOzY5dp9MR  session-memory-curator
  [in-repo] session-memory-curator｜仓内半行：R75 事实落笔记
    动作类型 repo-doc · 巡检间隔 720 · 仓库路径 D:\BaiduSyncdisk\Obsidian Vault\当前项目
    gate     repo-doc (cell=column) · prose-only repo-doc [笔记]
    scope    silent (roots: D:\BaiduSyncdisk\Obsidian Vault\当前项目)
  [waiting] session-memory-curator｜等人半行：A/B/C 批复与 curator 策略
    动作类型 (blank) · 巡检间隔 0 · 仓库路径 D:\BaiduSyncdisk\Obsidian Vault\当前项目
    gate     secret [凭证] (cell=text) · prose-only secret [凭证]

reczz28SSxObE9Ec  多媒体-登出串号
  [in-repo] 多媒体-登出串号｜仓内半行：applyTokenSite 单测
    动作类型 repo-test · 巡检间隔 1440 · 仓库路径 E:\repos\gitAll\articleeditor-tmp
    gate     repo-test (cell=column) · prose-only repo-code [分支]
    scope    aligned (roots: E:\repos\gitAll\articleeditor-tmp)
  [waiting] 多媒体-登出串号｜等人半行：pod 日志与跨仓登出
    动作类型 (blank) · 巡检间隔 0 · 仓库路径 (empty)
    gate     field-ops [现场] (cell=text) · prose-only field-ops [现场]

splits 2 · in-repo halves dispatchable 2/2 · waiting halves refused 2/2 · clauses not traceable 0
```

三处值得单独读的读数：

1. **「clauses not traceable 0」是这份提案的硬约束。** 每个半行都带 `from`：它由原行 `下一步` 的哪几段
   逐字组成。脚本断言每一段都是原行的子串，所以提案只能「搬动」原行写过的事，不能顺手加一件新活；
   改措辞可以看见（`1 篇 note` → `1 篇笔记`），加任务不行。测试 `catches a proposal that invents a clause`
   用被截短的行验证这条断言真的会红。
2. **仓内半行靠列，不是靠词表。** 第一个半行的纯词表读数就是 `repo-doc`（命中「笔记」），第二个半行
   纯词表读成 `repo-code`（命中「分支」），要写 `动作类型=repo-test` 才读成测试——这就是上一轮
   「改写是改两格」的落地：`下一步` 和 `动作类型` 一起改，缺一格都翻不动。
3. **等人半行两行都被拒，且拒的理由不同**（`secret` / `field-ops`）。这不是失败读数：它们本来就该在
   `巡检间隔=0` 上停跑，词表读数只是第二道闸。

## 5. 仓库路径 vs 动作目录：全表 78 行的实测计数

需求里的「统计仓库路径与动作目录不一致的行数」，用新脚本量。判据只有一条：`下一步` 里写出的**磁盘上
真实存在**的目录，是否落在该行 `仓库路径` 的候选目录里面。不存在的路径 token 一律不计（那是散文噪声，
比如 `D:\gitAll工作盘当前掉线暂无法写入`）。

```powershell
node scripts/scope-audit.ts
```

```
rows 78 · aligned 3 · drift 3 · no-root 2 · silent 70
due  12 · aligned 0 · drift 0 · no-root 0 · silent 12

--- drift (3) ---
  recvu7y1Za7YXp [off] 多媒体-选用
    仓库路径 D:\gitAll\articleeditor-tmp [repo-exists-ok]
    下一步 names D:\gitAll\auto-deploy — outside every root
  reczz28MPstPVjaf [off] minimax-code
    仓库路径 E:\repos\gitAll\minimax-code [repo-exists-ok]
    下一步 names C:\Users\47037\.minimax-code — outside every root
  reczz28O130mDDnb [off] newmedia-task-assistant
    仓库路径 E:\AI-Portable\codex-home\skills\newmedia-task-assistant [repo-exists-ok]
    下一步 names D:\UserData\Documents\Codex\2026-10-16\skill-https-my-feishu-cn-base\work\newmedia-task-assistant — outside every root

--- no-root (2) ---
  recvsHOAmvVKKN [off] dsh探索/贡献
    仓库路径 (no directory) [repo-empty-cell]
    下一步 names D:\gitAll\dsh-superagent-prototype — outside every root
  recvvPSdSO6yTa [off] OpenEyes / third-hand 计算机使用借鉴调研
    仓库路径 (no directory) [repo-not-cloned]
    下一步 names D:\gitAll\agent-cloud-harness\docs — outside every root
    下一步 names E:\gitAll\openeyes\docs — outside every root
```

答案分三层，缺一层就会读错：

1. **全表 78 行：不一致 3 行（drift），另有 2 行「写了目录但没有仓」（no-root）。** 这 5 行都是 `巡检间隔=0`
   的停跑行——它们今天不会被派工，所以是「表里的错，不是正在发生的错」。
2. **due 集 12 行：drift 0 / no-root 0 / silent 12。** 也就是说，**这一轮的 12 行没有一行在 `下一步` 里写过
   任何目录**。不一致的答案不是「0 行没问题」，而是「12 行全部不可判定」——`silent` 就是「这行没说它在哪动手」。
   这也是为什么计数只能当**下界**：`reczz28QOfrbeaIn` 的仓写的是 vault、真正要改的巡检脚本在
   `D:\_codex-control`（本机存在，`Control.ps1` / `Panel.ps1`），但它 `下一步` 里一个路径都没写，
  本脚本只能判它 `silent`，抓不到这条已知的错。
3. **抓不到的那一类要靠两种东西补**：格级体检（`repo-cell-audit.mjs`，18 格 offender）和人的判断。
   `silent` 的存在本身就是结论：想让「仓库路径对不对」可自动复核，行的 `下一步` 必须写出它要动的目录，
   否则 Gate 只能信格子里那个值。

## 6. 与其它脚本的分工

| 脚本 | 回答的问题 | 是否判行 |
| --- | --- | --- |
| `repo-cell-audit.mjs` | 表级：`仓库路径` 每格是什么状态、人要做哪一步 | 否（只看格） |
| `scope-audit.ts` | 行级：这行的 `下一步` 动的目录在不在它自己的仓里 | 是（只读两个格） |
| `local-json-round.ts` | 当下：这一轮 due 行里，仓库事实占 `ignored` 多少 | 是（真跑 Gate） |
| `rewrite-rehearsal.ts` | 假设：改写后词表翻不翻得动；拆成两行后各自被读成什么 | 否（只看给定改写/拆行） |
| `shadow-run.mjs` | 同上，但直连 Bitable 源、需要 lark 身份 | 是 |

## 7. 审批要点与风险

- **要批的只有一件事**：是否按 §2 / §3 在表里新建两行（行 A、行 B）并改写原两行为「等人半行」。
  按巡检纪律，建行与改表结构一律不自作主张；本文件只做提案。
- 风险：**low**。改的是两行的 `下一步` / `动作类型` / `巡检间隔`，不删行、不删列；原行 `用户批注`
  历史全部保留在等人半行里，可回滚（把 `巡检间隔` 改回原值、删掉新建的两行即可）。
- 建行之后的第一件事不是开闸，是跑一轮 `node scripts/local-json-round.ts --dump --any-repo`，
  看 `observed` 是否真的从 0 变正——拆行的目的就是这个数，不是表格好看。

## 8. 验证

```powershell
npx tsc --noEmit                                     # clean
npx vitest run tests/scope-audit.spec.ts             # 15 passed
npx vitest run tests/rewrite-rehearsal.spec.ts       # 12 passed
npx vitest run                                       # 326 passed (23 files)
node scripts/scope-audit.ts                          # 上面 §5 的读数
node scripts/rewrite-rehearsal.ts                    # 上面 §4 的读数
```
