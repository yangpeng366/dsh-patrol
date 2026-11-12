# 决策提示词：一行输入 → 固定三行输出

这份文档说明 `prompts/decide-next-action.md` 这一层：它吃什么、吐什么、怎么解析、出了错谁负责，
以及它能不能替代 `src/core/policy.ts` 里现有的硬编码判定。

一句话：**它只负责「下一步具体做什么、要不要人拍板」，不负责「这一行该不该跑」。**

## 1. 为什么单独一层

方向表的 `下一步` 列是自然语言，今天只能靠人读。把「这一行现在该做什么」交给模型是合理的——
那是判断，不是权限。但判断必须落在**固定格式**里，否则下游拿到的是一段散文，既不能写回表，
也不能进决策日志。所以这一层被切成两半，边界很硬：

| 部分 | 位置 | 只做什么 |
| --- | --- | --- |
| 提示词 | `prompts/decide-next-action.md` | 把一行 item 变成三行（可选第四行） |
| 格式解析 | `src/core/decision-answer.ts` | 只核格式，不核语义 |
| 命令行 | `scripts/parse-decision.ts` / `patrol decide` | 加 IO 与退出码 |

模型给的是**建议**，不是许可。任何带外部副作用的动作仍然要过 Gate 和人工审批；
解析器也不会因为「动作看起来像发布」就拒绝它——那种语义判断属于 `src/core/action-vocabulary.ts`
与 `src/core/policy.ts`，不属于格式层。

## 2. 输入：item 契约

提示词里的输入行与 `schemas/item.schema.json` 一一对应，没有新造字段：

| 提示词里的行 | item 字段 | 作用 |
| --- | --- | --- |
| `id` | `id` | 回答与哪一行对应 |
| `title` | `title` | 人可读标题 |
| `repoPath` | `repoPath` | 本地仓库；空则该轮不给改仓动作 |
| `description` | `description` | 这一行要做什么 |
| `nextStep` | `nextStep` | 方向表「下一步」原文 |
| `priority` | `priority` | `P0` / `P1` / `P2` |
| `intervalMin` | `intervalMin` | 0 或空 = 停跑，提示词要求写「待人工确认」 |
| `threadId` | `threadId` | 续跑会话 |
| `fake` | `fake` | `true` 时只给可逆动作 |
| `lastRun` | `lastRun` | 上一轮时间 |
| `currentStage` | `currentStage` | 当前阶段 |
| `achievement` | `achievement` | 上一轮已落地的产出 |
| `actionType` | `actionType` | 「动作类型」列原文；取值**以词表为准** |

提示词里不抄词表：九种取值的唯一事实源是 `src/core/action-vocabulary.ts`，提示词只写
「以词表为准」。`tests/parse-decision.spec.ts` 用导入的方式守住这条——提示词里出现任何一个
kind 的独立词形，测试就红。

## 3. 输出契约

必答三行，顺序固定：

```text
动作: <本轮唯一要做的一件事，一句祈使句>
理由: <不超过 30 字>
人工介入: 是 ｜ 否
```

可选第四行（本轮若有可复用做法）：

```text
沉淀: - <做法> — <命令>
```

`沉淀` 整行内容原样进 `skillNote`，解析器不拆「做法」和「命令」——拆法是一种判断，
而这一层不做判断。`人工介入` 只接受 `是/否` 与 `yes/no/true/false`（大小写、首尾空白归一化）。
`是 ｜ 否` 这种没选边的回答直接算错：把「没选」读成「否」等于替人放权。

## 4. 解析器

```text
JSON: { action, reason, needsHuman, skillNote, ignoredLines }
```

- `ignoredLines` 记录所有非空、但不是四种标签的行（寒暄、围栏、事后解释）。它们不参与解析、
  不导致失败，只是留痕——「模型多说了什么」这个问题永远可查。
- 代码围栏整行进 `ignoredLines`，围栏里面的三行照常解析。
- 标签值里允许 markdown 装饰：`- `、`* `、`1. `、`> ` 前缀与 `**` 会被去掉。
- 容错**只到这里**：标签必须是四个之一，`人工介入` 必须是六种写法之一，其余一律报错。

### 错误码

格式不合规抛 `DecisionParseError`，`message` 形如 `CODE:field|中文说明`：

| 错误码 | 触发 |
| --- | --- |
| `E-MISSING-FIELD` | 三行里有一行没出现 |
| `E-DUPLICATE-FIELD` | 同一行出现两次（两个答案，无从选择） |
| `E-EMPTY-FIELD` | 行出现了，冒号后面是空的 |
| `E-BAD-FLAG` | `人工介入` 不是 是/否/yes/no/true/false |

冒号后是稳定 ASCII 字段 id：`action` / `reason` / `humanFlag`。中文说明在后半段；
控制台代码页把中文降级成 `?` 时，ASCII 前半段仍然可 `grep`。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 解析成功，JSON 在 stdout |
| 1 | 参数缺失、文件不存在或读不出来（`E-NO-INPUT` / `E-INPUT-NOT-FOUND` / `E-READ-FAILED` / `E-BAD-ARG`） |
| 2 | 回答格式不合规（四个 `E-*` 之一） |

## 5. 两种用法

```bash
# 1) 独立脚本：零依赖、离线、无凭据
node scripts/parse-decision.ts answer.txt

# 2) 命令行（与 rows / row / report 同一套退出码），不读数据源
node src/cli.ts decide answer.txt
patrol decide answer.txt
```

`patrol decide` 故意排在数据源解析之前：解析一份回答不该需要表 token，
`pnpm test` 与 CI 也就能在没有凭据的机器上跑这一层。

## 6. CI

`.github/workflows/verify.yml` 在 `pnpm test` 之后多一步
`pnpm exec vitest run tests/parse-decision.spec.ts`。`pnpm test` 本来就会跑到它；
单独一步是为了让红灯直接指向一个文件，而不是 18 个文件里的某一条。

## 7. 它能不能替代现有的硬编码判定

**能替代的：**「下一步做什么」这一问的判断。今天这一问只存在于 `下一步` 列的自然语言里，
没有人读就走不下去；`action-facts.ts` 的词表只能回答「这句话像哪类活」，回答不了「具体做哪件事」。
提示词把这一问变成一个可解析、可留痕、可离线回归的产物，而且不需要模型有权限——
它给的是动作建议与「要不要人拍板」。

**不能替代的（跑完这一层仍然必须走）：**

1. **Gate 的准入判定**（`src/core/policy.ts`）——停跑、审批状态、授权边界、仓白名单、
   仓库存在性、动作类型拒绝、同仓已有 Ticket。这些是结构化事实的 fail-closed 规则：
   一条模型回答永远不能变成许可，否则「白名单」就退化成了提示词里的建议。
2. **动作类型词表与归类**（`src/core/action-vocabulary.ts` / `action-facts.ts`）。
   提示词只写「以词表为准」，解析器不校验 `actionType`，写回与统计仍然只走唯一那次读取。
   把校验搬进解析器，会让格式层长出一个语义判断，正是 Gate 最不该有的形状。
3. **事实采集**：`repo-facts.ts` 的探针、`mapping.ts` 的指纹与 due/stopped 分流。
   模型看不到磁盘，也不该被要求报告「这个目录还在不在」。
4. **调度、去重、写回**：`runner.ts` 的到期分流、`Trigger` 指纹去重、
   `patrol report` 的写回路径与 `外部成就` 追加语义。
5. **语义校验**：解析器不判断动作是否合理、理由是否成立、`actionType` 与动作是否一致，
   也不限 `理由` 的 30 字。它保证的是「下游能稳定取到三个字段」，不是「回答质量合格」。
   所以它不能当质量门禁；质量只能靠 Gate 的拒绝理由 + 决策日志回看。

一句话：这一层替代的是**判断**，不是**权限**。谁能起活仍然是纯代码的 Gate；
提示词只是把「做什么」从散文变成结构，让判断可以被记录、被复盘、被离线回归。
