# AGENTS.md — dsh-patrol 交接说明

## 1. 这是什么

DSH Source 插件：把飞书多维表格的「项目方向」表（也支持本地 JSON）读成任务源——每个到期行变成一个
Trigger，在版本化 Policy 下过闸，通过的开 Ticket 并派发，最后把结果写回同一张表。

## 2. 六条主要思路

1. **单一词表事实源 + 四态统计。** 「动作类型」的九种取值只写在 `src/core/action-vocabulary.ts`；
   全仓只有一个读法 `readActionCell()`，一个单元格四态：`valid`（原样）、`normalized`（仅 trim +
   大小写折叠后救回）、`missing`（无列 / 空单元格）、`invalid`（其余一律非法，记为 `unclear`，
   计入 `invalid_action`，绝不猜）。`countActionCells()` 保证四态之和 = total。
2. **非法值拒写表。** 写回一律走 `writeActionCell()`，不在集合内的值直接抛错；`patrol report
   --action-type auto` 退出码 2 且不写表；Gate 读到非法列值判 `unclear` 并拒绝，**不**退回词表
   （否则打错字会被重新读成 `repo-code`）。
3. **停跑语义：intervalMin = 0 即 disabled。** 表的 `巡检占用` 列写明「0=禁用巡检」；
   `itemIsDue()` 对 `intervalMin <= 0` 返回 false，不进 Gate；该行仍以 `verdict=stopped` /
   `reason=schedule-stopped` 进决策日志，「哪些行停跑」始终是一条查询。
4. **三条写路径同一闸门。** `patrol report --action-type`（`src/cli.ts`）、`BitableSource.writeBack()`、
   `LocalJsonFileSource.writeBack()` 写「动作类型」列时都过同一个词表读 / 写函数——校验先于任何
   字段变更，不留半写。
5. **证据与理由同源。** `ActionFacts.evidence` 记的是单元格原文，`reason` 引用同一段文字；单元写
   `AUTO` 时日志记 `AUTO` 而不是折叠后的 `auto`，理由与证据永不互相矛盾。
6. **决策可由模型给出，阈值留在代码。** 「谁可以起活」是纯代码的 Gate（白名单、间隔、动作类型都是
   结构化字段，不读 `下一步` 的自然语言）；「这活值不值得做」是模型的 Assessment，只看有界事实、
   从不看授权。`acceptMode` 默认 `observe`，阈值改动只改代码。

## 3. 关键文件一览

| 路径 | 作用 |
| --- | --- |
| `src/core/action-vocabulary.ts` | 词表事实源：九个取值、四态读法、写回校验、`verifyActionVocabulary()` 不变量 |
| `src/core/action-facts.ts` | 从「动作类型」列或词表读出 kind + 证据 + 理由；每种 kind 的拒绝码 |
| `src/core/policy.ts` | Gate：版本化准入规则（纯代码，不调模型），拒绝理由即 reason |
| `src/core/repo-facts.ts` | 把「仓库路径」单元格探成 `exists / kind / normalizedPath / reason` |
| `src/core/engine.ts` | 一轮：收 Trigger → 过闸 → Assessment → 开票；开票前用当次集合重过闸 |
| `src/core/eval.ts` | Assessment（模型侧）与 `acceptMode`（off / observe / auto） |
| `src/core/decision-log.ts` | 决策的 append-only JSONL 审计（UTF-8 无 BOM） |
| `src/mapping.ts` | 行 → Trigger / facts / 指纹；`itemIsDue()`、`itemIsStopped()` |
| `src/source/provider.ts` | 行契约 `DirectionItem` 与 `SourceProvider`（listItems / writeBack） |
| `src/source/bitable.ts` | 飞书多维表格源（经 `lark-cli`），含「动作类型」列的读与写 |
| `src/source/local-json.ts` | 本地 JSON 源（可写变体 `LocalJsonFileSource`） |
| `src/cli.ts` | `patrol` 命令行：`rows` / `row` / `report` |
| `src/index.ts` | 插件入口与 `Config`（zod） |
| `src/runner.ts` | 一轮编排：读行 → due / stopped 分流 → 派发 → 写回 |
| `src/dispatch.ts` | Dispatcher：`log` / `codex` / `dsh` |
| `schemas/item.schema.json` | item 契约（只作说明，刻意不写 enum） |
| `scripts/release-check.mjs` | 发布自检：三道门 + 打包内容 + 解包 CLI 自检 + 版本一致 |
| `scripts/policy-audit.mjs` | 读回决策日志，给出 counts / wouldAccept / stopped |
| `scripts/policy-triage-check.mjs` | 用同一份模块重算方向表，与 `docs/policy-v4-triage.md` 逐项核对 |
| `docs/policy-v4-triage.md` | v4 口径、68 条逐条定性、实测数字与残余风险 |
| `tests/` | 17 个文件 / 216 例，钉住闸门、词表、指纹、日志、审计 |

## 4. 常用命令

Node ≥ 22.19（`node src/cli.ts` 直接跑 TypeScript 源码）。以下命令均在本仓实测通过：

```bash
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（17 files / 216 tests）
pnpm build              # tsdown → lib/index.js + lib/cli.js
node scripts/release-check.mjs   # 0=PASS，1=某项检查失败，2=用法错；另有 --skip-steps / --keep-temp
```

CLI（先跑 `--help` 看用法；`--source` / `--tasks-file` 亦可写作 `PATROL_SOURCE` / `PATROL_TASKS_FILE`）：

```bash
node src/cli.ts --help
node src/cli.ts rows --source local-json --tasks-file <path>
node src/cli.ts row <id> --source local-json --tasks-file <path>
node src/cli.ts report <id> --stage "已实现" --next "补 CLI 测试" --achievement "做了什么，证据是什么" --source local-json --tasks-file <path>
```

`report` 默认给「外部成就」追加一块带时间的记录，`--replace` 才覆盖；`--achievement -` 从标准输入读；
`--action-type` 只接受九个规范取值（大小写与首尾空白会归一化，其它值直接报错、不写表）。

## 5. 改动规矩

1. **不要引入第二份词表。** 新增动作取值只改 `src/core/action-vocabulary.ts`，并同步
   `src/core/action-facts.ts` 的 `REFUSALS` 映射（穷举类型，漏一处编译不过）。
   `schemas/item.schema.json` 刻意不写 enum，免得它变成第二份词表。
2. **非法值一律 fail-closed。** 读不到、猜不出、事实缺失 → 拒绝（`unclear` / `*-unknown`），
   不要猜成 `repo-code` 之类。
3. **UTF-8 无 BOM。** 源文件、决策日志、写入表的文本都不带 BOM。
4. **提交前必跑** `pnpm typecheck` + `pnpm test` + `node scripts/release-check.mjs`，三者全绿才算完。
5. **不要 `git commit` / `git push`。** 改动留在工作区，交由人来提交。

## 6. 接口速查

**item 契约**（`schemas/item.schema.json`）：必填 `id` / `title` / `priority`（`P0`｜`P1`｜`P2`）/
`intervalMin`（≥ 0）；其余 `repoPath` / `description` / `nextStep` / `threadId` / `fake` / `lastRun` /
`currentStage` / `achievement` / `actionType`。运行时 `DirectionItem`（`src/source/provider.ts`）是它的
超集，另带多维表格自己的列（`authorization` / `collaboration` / `approval` / `userNote` /
`contribution` / `pendingAction` / `category`）。

**动作类型九种规范取值**（`src/core/action-vocabulary.ts`）：
`repo-code` · `repo-test` · `repo-doc` · `field-ops` · `release` · `secret` · `config` · `decision` · `unclear`

**CLI 退出码**（`src/cli.ts`）：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 参数、配置或行不存在：未知命令、缺值、未知数据源 / 身份、未知动作类型、找不到该 id、未给命令 |
| 1 | 运行期失败（非用法类的异常） |

## 7. 实践与调试（实测）

下面十一条都是踩过之后才知道的：症状 → 原因 → 对策。只写实测如此的部分，能给的命令都给了。

### 7.1 动作类型有三条写路径，漏一条闸门就形同虚设

- 症状：CLI 拒绝 `--action-type auto`（exit 2），本地 JSON 源却照写进去，下一轮读成 `invalid`。
- 原因：写「动作类型」的路径有三条——`patrol report --action-type`（`src/cli.ts`）、`BitableSource.writeBack()`（`src/source/bitable.ts`）、`LocalJsonFileSource.writeBack()`（`src/source/local-json.ts`）；只在一条上校验，另两条就是后门。
- 对策：三条都调 `writeActionCell()`（`src/core/action-vocabulary.ts`），校验先于任何字段变更；新增写路径必须挂同一个闸门，不要复制校验。

### 7.2 列豁免只认标签不认内容，非法值会穿合法 kind 的衣服

- 症状：手工构造 `{ kind: 'repo-code', source: 'column', field: '动作类型', evidence: 'auto' }` 能过闸。
- 原因：结构化列没有词表命中（`matched` 为空），闸门为它开了豁免；若只看 `source` / `field` 两个标签，豁免就成了免检章。
- 对策：豁免必须自证——`normalizeActionKind(fact.evidence) === fact.kind`（`src/core/policy.ts` 的 `refuseAction()`）；证据读不成同一个 kind 就按 `action-unclear` 拒绝。

### 7.3 容错边界很窄：只 trim + 大小写折叠

- 症状：`repo_code`、`repo code`、全角连字符的写法一律 `invalid` 并被拒；被 NBSP 包着的值却能救回。
- 原因：`readActionCell()` 只做 `trim()` + `toLowerCase()`，fail-closed 是有意的：放宽一步，打错的字就会被重新读成 `repo-code`。
- 对策：不要「顺手」加别名表或分隔符归一；要支持新写法，先分清它是词表新值还是 typo。

### 7.4 evidence 必须记原文

- 症状：单元格写 `AUTO`，日志里记 `auto`，`reason` 与 `evidence` 自相矛盾。
- 原因：`evidence` 若取折叠后的 `value`，证据就不再是「表里写了什么」。
- 对策：`evidence` 取 `cell.raw.trim()`（`inspectAction()`，`src/core/action-facts.ts`），只有 kind 用折叠值；被归一化过的列值在 `reason` 里另写「已归一化为 X」。

### 7.5 词表加第 10 种，LEXICON 不会提醒

- 症状：`ACTION_KINDS` 加了新值，编译通过，却没有任何一行能被推断成它。
- 原因：`LEXICON` 的类型是 `Exclude<ActionKind, 'unclear'>`，新值不写进词表也满足类型；没有词、没有优先级，它就永远不出现在结果里。
- 对策：靠导出的 `LEXICON_KINDS` 与 `tests/action-vocabulary.spec.ts` 的断言守住（须与 `ACTION_KINDS` 去掉 `unclear` 后逐项相等）；改词表同时补 `action-facts.ts` 的 `REFUSALS`。

### 7.6 发布物会与代码脱节

- 症状：CI 绿，`node scripts/release-check.mjs` 红。
- 原因：改了计数口径（四态 / `invalid_action` / `source-column`）却没同步 `docs/policy-v4-triage.md` 的 `triage-action` 块；`scripts/policy-triage-check.mjs` 用同一份模块重算后逐项比对。
- 对策：改口径必同步 doc 块，提交前跑 `node scripts/policy-triage-check.mjs --doc docs/policy-v4-triage.md`。

### 7.7 打包内容由 package.json 的 files 决定

- 症状：本地能跑，装了插件的人报缺文件（曾漏过 `prompts/`）。
- 原因：`files` 只列了 `lib` / `cordis.patch.yml` / `README.md` / `CHANGELOG.md` / `docs` / `skills` / `prompts`；新增运行时文件没加进去，就不会进 tarball。
- 对策：新增运行时文件同时改 `package.json` 的 `files` 与 `scripts/release-check.mjs` 的 `REQUIRED_ENTRIES`（现为 9 项，含 `package/prompts/decide-next-action.md`）。

### 7.8 跨平台换行：先归一再哈希 / 计字节

- 症状：CI 把「没人动过的文件」判成改动，哈希对不上。
- 原因：本机 `git config core.autocrlf` 为 `true`，同一文件 Windows 出 CRLF、Linux 出 LF；凡是把文件内容哈希或计字节的产物（如索引）直接算，就会得到两个值。
- 对策：读入后先 `replace(/\r\n?/g, '\n')` 归一，再算哈希或字节数；不要把行尾当成内容的一部分。

### 7.9 每轮 66 行 stopped 噪声把日志撑爆

- 症状：每轮把 66 条停跑行逐行写成 `stopped`，决策日志被撑爆；原因：停跑被当成每轮重复的判决，不是一个集合的状态；对策：改成集合状态机（`src/core/engine.ts` 的 `recordStoppedSet()`）——首轮 `snapshot` 全量，变更才写 `added` / `removed`，无变化满 `stoppedHeartbeatMs`（默认 12 小时）写一条 `heartbeat`。

### 7.10 进程重启后审计仍列着早已恢复的停跑行

- 症状：行已恢复运行，`policy-audit` 的 `stopped` 列表还挂着它；原因：重启时停跑集合为空就不写 `snapshot`，回放没有新一轮可清场，旧行永远留着；对策：空集合也写一条集合级 `snapshot` 标记（`triggerId=stopped-set`、`stoppedCount=0`），审计靠它换 round 清空集合，且该标记不计作停跑行。

### 7.11 重启把 stoppedSince 推后、停跑时长被低估

- 症状：重启后同一行 `停跑自` 变晚、停跑时长被算短；原因：`stoppedSince` 记本进程首见时刻，真实停跑不晚于它，故字段是上界、由此算的时长是下界，重启把它重基到较晚的快照时刻；对策：`scripts/policy-audit.mjs` 在同一份日志内对同一行保留更早的值（`earliestSince` 跨 snapshot 轮保留，只有 `removed` / `added` 才重置），不要拿清场后已丢失的 `stoppedRows` 去比。

### 本地自测怎么跑（仓内真实命令）

Node ≥ 22.19，源码可直接跑（`node src/cli.ts`）。提交前四条要全绿，改口径或查日志时再跑后三条：

```bash
pnpm typecheck
pnpm test
pnpm build
node scripts/release-check.mjs
node scripts/policy-triage-check.mjs --doc docs/policy-v4-triage.md
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110.jsonl --json
node src/cli.ts report <id> --stage "已实现" --action-type auto --source local-json --tasks-file <path>   # 预期 exit 2，文件不变
```
