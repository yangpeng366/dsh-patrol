# Policy v3：无人值守轮次的仓库白名单改为「默认拒绝」

日期：2026-11-11 · 适用版本：`policyVersion: v3` · 依据：2026-11-10 真实轮次日志 + 2026-11-11 01:30 读取的方向表（rev 4368）

## 1. 为什么要改

Policy v2 的仓库层是 fail-open：

```ts
// v2 — src/core/policy.ts
private refuseRepo(facts) {
  if (this.autonomousRepos.length === 0) return undefined   // 没配白名单 = 不限制仓库
  ...
}
```

「没配白名单」和「所有仓库都放行」在代码里是同一件事。真实轮次给出了后果：同一张 78 行方向表，
不加白名单时 `would-accept = 68`；加 15 个仓库前缀后 `would-accept = 16`。差的 52 行不是变少了工作，
而是 v2 把现场仓、外部上游仓、发版行、需要人工拍板的行一并算成了「可自主」。

复现命令（只读日志，不接触表、不派发）：

```powershell
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110.jsonl --json
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110-v2.jsonl --json
```

| 日志 | 白名单 | records | would-accept | 主要拒绝原因 |
| --- | --- | --- | --- | --- |
| `patrol-decisions-20261110.jsonl` | 未配置 | 78 | **68** | `read-only-direction` 8、`no-next-step` 1、`needs-approval` 1 |
| `patrol-decisions-20261110-v2.jsonl` | 15 个前缀 | 78 | **16** | `repo-not-autonomous` 42、`no-repo-path` 8、`repo-not-cloned` 2 等 |

v3 只动「仓库」这一层与默认值。`approval` / `authorization` / `nextStepPresent` / `ticket-already-open`
四道闸原样保留，顺序不变（仓库层仍在 ticket 层之前）。

## 2. v2 与 v3 的行为差异

| 场景 | v2 | v3 |
| --- | --- | --- |
| `autonomousRepos` 为空（含全空白项） | 放行任意仓库（fail-open） | **一律拒绝**，reason `repo-allowlist-unset` |
| `autonomousRepos` 为空 + `allowAnyRepo: true` | 不存在该开关 | 放行（唯一保留旧行为的方式，默认 `false`） |
| 白名单命中（前缀、大小写、`/` 与 `\`、尾斜杠归一化） | 放行 | 放行，语义不变 |
| 白名单未命中 | `repo-not-autonomous` | `repo-not-autonomous`（不变） |
| 行内无仓库路径 | `no-repo-path` | `no-repo-path`（白名单已配置时） |
| 行内标注「（未克隆）」 | `repo-not-cloned` | `repo-not-cloned`（不变） |
| 已存在 open ticket | 仓库层通过后，**任意** open ticket 都报 `ticket-already-open`（进程级） | 顺序不变，但范围收紧为**同一仓**：同仓其他行的 open ticket 才算，其他仓不再被连坐（见 §7） |
| `policyVersion` 默认值 | `v1` | `v3` |
| `revalidate()` 跨版本 | 同版本通过；新版本不撤旧 Mandate，但拒绝放宽 inferred | **不变**（见 §5 残余风险） |

空数组不再能被当成通配符：`[]`、`['', '   ']` 都按「未配置」处理，一律 `repo-allowlist-unset`。
代码注释与测试名都写明了这一点：*an empty array is what a forgotten setting looks like, not a permission*。

## 3. 16 条 would-accept 的归类

判据（未放宽）：只有「自有仓 + 只做代码/测试/文档 + 可本地验证 + 不发布、不推送外部 PR」才放行；
发版、外部上游 PR、数据/阈值判断、厂商 SDK、现场环境、跨仓联调，一律需审批或只读。
「现在为什么会被放行」在所有行上都是同一个机制：v2 空白名单 ⇒ `refuseRepo()` 返回 `undefined`，
该行又满足 `授权边界=自主`、`审批状态` 未拦、`下一步` 非空，于是直接进入 Assessment。

| 项目名 | scope 路径 | 现在为什么会被放行 | v3 结论 | 一句理由 |
| --- | --- | --- | --- | --- |
| networkx | `D:\gitAll\networkx` | v2 空白名单 fail-open；自主 + 有下一步 + 审批未拦 | 需审批 | 外部上游仓，下一步是盯维护者评论与 PR 评审，v3 不允许无人值守代提/推进上游 PR。 |
| agent-cloud-harness | `D:\gitAll\agent-cloud-harness` | 同上 | 需审批 | 下一步是 Typesafe/Jev key 轮换、写 `~/.openclaw/secrets`、删除 `.git.bak-*`，涉及凭据与破坏性删除。 |
| OpenEyes | `E:\gitAll\openeyes` | 同上 | 需审批 | 行内含标注阈值决策、Lightpanda/WSL 与隧道承载现场复测，不是纯代码改动。 |
| EchoBird | `D:\gitAll\EchoBird` | 同上 | 需审批 | 下一步要求人工先复核已保存的 Codex 输出，再决定是否重跑。 |
| patrol-scaffold 开源脚手架 | `D:\gitAll\patrol-scaffold` | 同上 | 需审批 | CI 真闸门要跨仓 checkout `dsh-patrol`，属跨仓联调。 |
| agent-cloud-harness / OpenEyes UI 自动化接入 | `D:\gitAll\agent-cloud-harness` | 同上 | 需审批 | ACH × OpenEyes 跨仓接入，且当前下一步是 19 天无增量的状态复盘。 |
| Jev 开源项目跟踪 | `D:\gitAll\awesome-jev` | 同上 | 只读 | 只跟踪外部项目 D1–D5 拍板与索引新增，产出观察、不改仓。 |
| Jev 决策模式吸收清单 | `D:\gitAll\awesome-jev` | 同上 | 只读 | 对照 ACH/OpenEyes 的门控与路由做评估，只读比较、先给最小验证再谈拆任务。 |
| codex-ccx-portable | `D:\gitAll\codex-ccx-portable` | 同上 | 需审批 | 新机安装官方 CCX + PowerShell bootstrap + Nginx 8443 链路验收，依赖现场机器与厂商安装包。 |
| 灵活 Agent 编排与云 Runtime | `D:\gitAll\pi-agent-cloud` | 同上 | 需审批 | CCX 容器化需另一台有 Docker 的机器，且含 provider key 轮换与外部技能源同步。 |
| OpenAgentCore | `E:\repos\gitAll\OpenAgentCore` | 同上 | 只读 | 外部仓只做协议通读与 ACH 对照笔记，行内明写「不动手」。 |
| XERJ 检索层吸收（本地搜索 + System One） | `E:\AI-Portable\xerj-data` | 同上 | 需审批 | 标注语料与阈值判断，且要改 `~/.codex` 配置、下载权重、对 Corpus Hub 取数。 |
| OpenEyes 质量门禁与价值驱动 | `E:\gitAll\openeyes` | 同上 | **放行** | 自有仓，只做门禁/契约/脚本收口，本地 `quality-gate.ps1` 可验，不发版不推外部 PR；其中「视觉档接真模型」应另立行按厂商依赖判需审批。 |
| 文稿智能工作台（独立写稿模块 + CLI skill） | `D:\gitAll\manuscript-writer` | 同上 | 需审批 | 「待拍板后发 0.15.2」是发版 + 线上脏标签率复验，需人拍板。 |
| 文稿智能工作台（manuscript-writer） | `D:\gitAll\manuscript-writer` | 同上 | 需审批 | 等用户验收 1.3.4，且持久安装受组织策略影响，属发版/现场安装。 |
| dsh-patrol 插件（方向表 → DSH Source） | `D:\gitAll\dsh-patrol` | 同上 | 需审批 | 行内第三项是「发 v0.1.0 release」；第一、二项（Policy v3、同仓并发演练）应拆成单独放行行。 |

计数：放行 **1** · 需审批 **12** · 只读 **3**。记录 ID 依次为
`recvriLOrYiTkY`、`recvriLOrYxRe4`、`recvrXCvTCZZnv`、`recvtyseVt7jdh`、`recvv0TxKLm7gh`、
`recvvNWh9u3lQZ`、`recvvQoJfFH1dY`、`recvw6rvQKOTOF`、`recvwtXyeKiM98`、`recvwtYIV3rvD1`、
`reczz28MPstPUO1y`、`reczz28Ru8Le1hfS`、`reczz28RzGKBlSEf`、`reczz28T4BtdsrI6`、
`reczz28TAm3Gctb3`、`reczz28XopBpg9xU`（与上表同序）。

## 4. 可直接贴进配置的放行清单

只按上表「放行」结论生成，因此只有一个仓库：

```yaml
config:
  policyVersion: v3
  autonomousRepos:
    - 'E:\gitAll\openeyes'
```

等价 JSON 数组：

```json
["E:\\gitAll\\openeyes"]
```

**仓库白名单是仓库级的，不区分行内任务类型。** 上表第 3 行（OpenEyes 主行）也在
`E:\gitAll\openeyes` 内，v3 会因白名单命中而放它进入 Assessment；它的结论是「需审批」，
必须靠行级字段落实，不能靠白名单表达：

- 把该行 `授权边界` 改成 `需审批`，或
- 把阈值/隧道部分拆到独立行并标 `需审批`，原行只保留代码/测试收口。

同理，`dsh-patrol` 本仓若要无人值守做 Policy v3 收尾，先把「发 v0.1.0 release」从该行拆出去；
在此之前不要把 `D:\gitAll\dsh-patrol` 放进 `autonomousRepos`。

## 5. 残余风险

1. **仓库级粒度**：白名单只能表达「这个仓可以动」，不能表达「这个仓的哪些行可以动」。同仓混合行
   （如 OpenEyes 主行、dsh-patrol 行）必须靠 `授权边界` / `审批状态` / 拆行治理，否则会被白名单顺带放行。
2. **已存在的 Mandate 不会因升到 v3 被撤销**：`revalidate()` 的语义是「新版本不撤旧 Mandate，只拒绝放宽
   inferred」。v2 下以空白名单放行、目前仍在运行的 explicit Ticket，在 v3 下继续存活到结束；v3 只约束
   新 Trigger。要立即收口必须显式结束这些 Ticket，不能指望改版本号。
3. **只改了默认值，不阻止显式配置**：调用方仍可写 `allowAnyRepo: true`，也可以把整块盘写进
   `autonomousRepos`。v3 防的是「忘了配」，不是「配错了」；配置评审仍必要。
4. **`acceptMode` 未改**：仍是 `observe`。本文只证明「谁会被放行」，不证明「放行后会安全执行」；
   切 `auto` 前的同仓单线程演练已落地为 `scripts/same-repo-rehearsal.ts`（§7），它证明的是
   「同一仓不会同时开两条线」，**不**证明多进程/多实例下的互斥，也**不**构成切 `auto` 的决定。
5. **决策日志只记结论不记行内容**：v3 重跑同一张表时，`repo-allowlist-unset` 会覆盖掉大部分行，
   但日志里从来没有 `下一步` 原文；本表的判断依据是 2026-11-11 01:30 读取的方向表 rev 4368
   （记录 ID 与日志一致），不是日志推断。行文若在 11-10 之后又改过，应以当时内容复核对应结论。

## 6. 验证

```powershell
pnpm test        # 68 passed (11 files)
pnpm typecheck   # tsc --noEmit, clean
```

新增/更新的断言：空白名单拒绝（含全空白项）、显式 opt-in 放行、白名单命中/未命中/归一化、
未克隆与无路径、`ticket-already-open` 顺序与按仓范围、Config 默认 `v3` 且 `allowAnyRepo=false`、
以及 §7 的同仓并发演练（5 个场景 + 时间窗重叠断言）。

## 7. 同仓并发演练

`ticket-already-open` 是切 `auto` 前的最后一道闸。方向表里多行指向同一个仓，而「一行一个 thread」
意味着「同一 thread 只有一条线」不足以代表「同一个仓只有一条线」；这条演练要证明的是后者。

```powershell
node scripts/same-repo-rehearsal.ts    # 全 PASS 退出码 0，任一失败退出码 1
pnpm test -- same-repo                 # 同一套场景的 vitest 入口（共用同一模块与同一套断言）
```

演练走 Engine 的真实路径（`Engine.runRound()` → `Policy.gate()` → `Assessor.assess()` →
`Engine.openTicket()` → sink），不是只调 `gate()`；Assessor 故意慢 60 ms，那段窗口就是两轮可能
重叠的地方。

判据（任一不满足即失败）：

| 场景 | 判据 |
| --- | --- |
| 同仓两行，先后到达 | 第一条 `admitted` 并开票；第二条 `ignored` / `ticket-already-open`；ticket 总数 1、派发 1 次 |
| 同仓两行，两轮同时发起 | 只有 1 条 `admitted`、1 个 open ticket、1 次派发；其余决策全为 `ticket-already-open`；两条 Assessment 时间窗重叠 > 0 |
| ticket ended 之后 | 第二条仍被挡；`endTicket(person)` 后第三条 `admitted`；open=1、总数 2 |
| 两个不同 repo 同时发起 | 每个 repo 各 1 条 open ticket、共 2 条，都被放行 |
| 白名单外同仓 | 两条都是 `ignored` / `repo-not-autonomous`，0 ticket（仓库层先于 ticket 层，并发绕不过） |

「同时发起」是字面意思：`runRound()` 连调两次、两次之间不 `await`，两次调用的 Assessment 时间窗
在报告里打印并断言重叠。2026-11-11 本机实跑样本：

```
[2] 同仓两行，两轮 runRound() 同时发起（不 await 中间）  (same-repo-concurrent)
    trg_recB1    verdict=admitted  reason=row-carries-next-step ticket=tkt_08830b5e1a4c  round=rnd_20261111T010000Z_1
    trg_recB2    verdict=ignored   reason=ticket-already-open  ticket=-  round=rnd_20261111T010000Z_1
    trg_recB1    verdict=ignored   reason=ticket-already-open  ticket=-  round=rnd_20261111T010000Z_2
    tickets=1 open=1  dispatched=1
    assessor windows: patrol:recB1[141.3..201.9]  patrol:recB1[141.4..202.4]
    overlap=60.5ms  elapsed=61.3ms  (assessor delay=60ms; overlap>0 means at least two assessments were in flight at once)
```

这条演练顺手暴露并修掉了两个缺陷（详见提交说明与报告）：

1. **`ticket-already-open` 原来是进程级的**：任意一个 open ticket 会挡住整张表的所有行，
   于是两个不同仓也无法并行。现在 `Ticket` 记录 `repoPath`，闸门只比同仓的 open ticket；
   没有 `repoPath` 的旧 Ticket 退回按 thread 比较，两者都没有时一律挡（fail-closed）。
2. **Gate 与开票之间存在 TOCTOU**：`Assessor.assess()` 是 `await`，两轮可以同时通过 Gate
   再各自开票（同 thread 会覆盖同一张 ticket 并重复派发）。现在 `openTicket()` 之前用当前
   ticket 集合**重新过闸**，且重检与开票之间没有 `await`，所以提交是原子的；另外，已被
   另一轮判过的 Trigger 在本轮会被跳过，不再重复判定。

边界：这条演练只覆盖**单进程内**的并发（同一个 `Engine` 实例）。ticket 存放在内存 `Map` 里，
多进程/多实例、或重启后的进程都不共享这份状态；那种情况下要靠「一仓一实例」的部署约束，
不能靠这条演练。演练也不改 `acceptMode`：它证明并发闸门有效，不构成切 `auto` 的决定。
