# DSH 插件落地清单 v1

> 取证方式：直接读 `D:\gitAll\dsh-superagent-prototype`（DeepSeek 官方 superagent 研究原型，MIT，commit 8c32a9d）与本仓 `dsh-patrol`（commit 354c357）的真实文件，并只读拉取 `github.com/deepseek-ai/deepseek-harness` 的 `CONTRIBUTING.md`、`.github/pull_request_template.md`、`docs/user/develop/basic/publish.md`、`docs/user/develop/framework/index.md`、`docs/subsystems/skills.md`、`docs/subsystems/settings.md`、`docs/cookbook/adding-a-package.md`。
>
> 调研由 SCNet-Max 子 agent 执行（会话 `el-id-7641-1988`，2026-11-10），本文件为结论的落地版：每条只留可执行的部分，行号为取证当时的行号。

## 0. 两处需要更正的前提

- `schemas/item.schema.json` 与契约自测**原本不在**本仓：`src/source/provider.ts:3-4` 只有一句注释指向它们，实物在 `patrol-scaffold`。**已处理**：契约已复制进本仓 `schemas/item.schema.json`，并新增 `tests/contract.spec.ts` 作机器校验（两份同源，改动须同步）。
- 上游**目前不接受外部 PR**，这是官方文字：`CONTRIBUTING.md:9` — "we cannot accept external pull requests at the moment"。所以"贡献只走 PR / discussion"要改为：**对外只有 Discussions + 生态（`dsh-plugin` topic、写文章、答疑）**。

---

## 1 插件最小骨架

**规则：`inject` 只列运行期真正读取的 host 服务；声明即等待，服务消失即卸载重载。可选服务用 `ctx.inject([...])` 在子 fiber 里挂，不放进顶置 `inject`。**

- 官方语义：有 `inject` 的插件要等每个必需服务就绪才加载，服务消失时自动 `ACTIVE → DISPOSED`，回来再加载（`docs/user/develop/framework/index.md:28-38`）。
- 原型顶置 `inject` 列 11 个服务：`dsh-superagent-prototype/src/index.ts:8`；并把 `settings` 排除在顶置之外，改用 `ctx.inject(['settings'], child => …)`（同文件 `:13`）——这是"非必需服务不进顶置清单"的实证。
- **`apply` 只做装配**：读配置 → 构造对象 → 注册拆卸 → 报告就绪；不自己开定时器跑业务。原型 `apply` 全长 15 行（`src/index.ts:10-25`），业务全在 `Runtime` 内。官方状态机里 `apply` 执行期是 `LOADING`，抛错即 `FAILED`（`framework/index.md:17-24`）。
- **`ctx.effect` 拆卸**：每个要清理的资源包一层 `ctx.effect` 返回 disposer；同一 effect 内的清理要串行 `await`，跨 effect 不保证顺序（`framework/index.md:40-63`）。
- **`settings.configure({auto:false})` 只在插件自带设置 UI 时需要**：纯 headless 插件保持默认 `auto: true`。语义见 `docs/subsystems/settings.md:29-38`；原型自带管理面板所以关自动页并写明理由（`src/index.ts:12-13`）。
- **`Config` 的声明方式**：原型用 `@deepseek-ai/schemastery` 定义 `Config`（`src/deployment.ts:6,15`），zod 只用于内部 API 校验（同文件 `:45-49`）；设置页要把 Config schema 投影成表单（`settings.md:29-45`）。**本仓待办**：Config 仍是 zod 对象（`src/index.ts:25-48`），改法是"Config 换 schemastery、zod 留作内部校验"，不是重写。

**本仓现状**：`inject` 已由 6 项收敛为 `['sessionController','skills']`（`src/index.ts`），`ctx.get('sessionController' as never)` 的 `as never` 已去掉；`apply` 已注册包内 skill、追踪在飞轮次、并在首轮成功后打印 ready。

---

## 2 打包与清单

| `package.json` 字段 | 作用 | 最小必填 | 依据 |
|---|---|---|---|
| `dsh.bundle.patch` | 声明该包是一个 bundle，指向被 profile 套用的配置层 | **是** | `docs/user/develop/basic/publish.md:13-16,35-44,64` |
| `dsh.client` | 声明 web 客户端入口（`platform` + 需注入的 client 包） | 否；带 UI 才需要 | 原型 `package.json:34-44` |
| `dsh.manifestVersion` | 清单版本号 | 否（指南最小清单无此项） | 原型 `package.json:45`、本仓 `package.json` 均写 1 |

- 没有 `dsh.bundle` 的包仍可安装，但只作普通依赖并给出警告、不激活任何层（`publish.md:64`）。
- `files` 必须包含入口文件与 `cordis.patch.yml`（`publish.md:41`）。
- `engines.dsh` 用 SemVer 声明支持范围，不满足则安装/启动拒绝（`publish.md:66`）。
- 与宿主共享实例的 dsh 包要**同时**进 `peerDependencies` 与 `devDependencies`（`publish.md:105`、`docs/cookbook/adding-a-package.md:27`）。**本仓已补**。
- 从 git 安装拿到的是源码不是产物，作者必须提供 `prepare` 脚本自洽构建（`publish.md:169-171`）。**本仓已补** `"prepare": "pnpm build"`。

### `cordis.patch.yml`

- 基本形状是 `- insert:` 下若干 `id`/`name`，`name` 用包名或包内子路径导出（`publish.md:56-62`）。
- 可选插件用 `disabled: true` 发布、由用户在自己的 profile patch 里打开（原型 `cordis.patch.yml:9-12`，开启方式见 `docs/008-cookbook.md:343-353`）。
- worker preset 是在 `standard` 上做减法：原型 preset 的完整写法见 `dsh-superagent-prototype/cordis.patch.yml:39-120`。**本仓已按此补齐**：shell 组（bash/pwsh 沙箱 + 工具，按平台互斥）、`tool-fs`、`tool-fs-search`、`tool-jobs`、`skill-filesystem`、`tool-skill`。

---

## 3 skill 打包

- `skills/<name>/SKILL.md` 需要 frontmatter：`name`（kebab、与目录同名）、`description`（单行、用于路由）。规范见 `docs/subsystems/skills.md:83-85,128,229`。
- **关键空白**：宿主的 filesystem skill provider 只扫工作区，**不扫插件包内目录**（`docs/subsystems/skills.md:64-77,85`）。所以包内 skill 必须由插件自己注册，否则宿主看不见。
- 注册方式：`ctx.skills.register({ name, description, content, source: 'runtime', resourceBase: { kind: 'directory', path } })`，返回的 disposer 交给 `ctx.effect` 托管（API 见 `@deepseek-ai/dsh-skill` 的 `SkillRegistration`；原型在 `src/app/sessions.ts:313-327` 注册作用域 skill）。
- 与 `prompts/` 的分工：`prompts/` 是可编辑的系统提示词模板，`skills/` 是给模型按需调用的操作规程。本仓行为约束写在 `skills/dsh-patrol/SKILL.md`，不需要 `prompts/`。

**本仓现状**：新增 `src/skill.ts`（读包内 `SKILL.md`、解析 frontmatter），`apply` 里用 `ctx.effect(() => ctx.skills.register(...))` 注册，resourceBase 指向 `skills/dsh-patrol`。

---

## 4 worker preset：怎么在 standard 上做减法

对照原型 `dsh-superagent-prototype/cordis.patch.yml:39-120`：

- **必须留**：`persona`（角色）、`agent-instructions`（指令上限）、`time-context`（时间）、`shell`（执行）、`tool-fs` / `tool-fs-search`（读写仓库）、`tool-jobs`（后台作业）、`skill-filesystem` + `tool-skill`（读 skill）、`compaction`（长上下文压缩）。
- **可以去**：`delegation`（子 agent）、`tool-web`（联网）、`tool-todo`、`tool-subagent-control`——巡检 worker 不需要自主上网或再分派。
- **本仓 preset 的取舍**：前台命令 5 秒后转后台 job，等待也 5 秒封顶，保证"一条命令或一次等待不压住人的下一条消息"。

---

## 5 契约与测试

- 对外可验证的最小契约 = **item 结构**（`schemas/item.schema.json`）+ 一份契约自测。契约唯一收口在 provider 层，任何适配器吐出的行都过同一把尺子。
- 本仓的契约自测：`tests/contract.spec.ts`（vitest，离线，不拉 meta-schema）；PowerShell 侧的同类自测在 `patrol-scaffold/scripts/adapter-contract-test.ps1`。
- dsh 侧三件套：`pnpm typecheck`（`tsc --noEmit`）、`pnpm test`（`vitest run`）、`pnpm build`（`tsdown`），`pnpm check` 串联三者。**现状：typecheck 通过、34 个测试全过、build 通过。**

---

## 6 我们与官方规范的差距清单

| # | 项 | 现状 | 要改 | 最小改法 | 状态 |
|---|---|---|---|---|---|
| 1 | worker preset 不完整 | `cordis.patch.yml` shell 组无 `config`，缺 fs/jobs/skill/compaction | 是 | 按原型 preset 整块搬入 | **已改** |
| 2 | skill 未注册，宿主看不见 | 只有 `skills/` 打包，无 `skills.register` | 是 | `ctx.effect(() => ctx.skills.register(...))` | **已改**（`src/skill.ts`） |
| 3 | `inject` 与使用不一致 | 6 项里 4 项未用；用 `as never` 取服务 | 是 | 收敛为实际使用的服务 | **已改**（`['sessionController','skills']`） |
| 4 | 无 `peerDependencies` | 只有 devDeps | 是 | 与宿主共享的包 peer + dev 成对 | **已改** |
| 5 | `Config` 用 zod，设置页无法投影 | zod 对象 | 是 | Config 换 schemastery，zod 留内部校验 | **待办**（需引入新依赖） |
| 6 | 循环无在飞跟踪 | disposer 只清定时器 | 是 | 记 `current`，disposer 里 `await current` | **已改** |
| 7 | 无就绪/失败边界 | 无条件打 ready | 是 | 首轮成功后再算 ready | **已改**（首轮成功后打 ready） |
| 8 | 契约文件不在仓库 | 仅注释引用他仓 | 是 | 契约进 `schemas/`，自测进 `tests/` | **已改**（两份同源，改动须同步） |
| 9 | 无 `prepare` | git 安装拿不到 `lib/` | 是 | 加 `"prepare": "pnpm build"` | **已改** |
| 10 | 无 `dsh.client` | 无 UI | 否 | 声明 client 反而要求 client 依赖与导出 | 不改 |
| 11 | 无 `prompts/` | 行为约束在 SKILL.md | 否 | 需要可编辑系统提示词时再加 | 不改 |
| 12 | `manifestVersion` 无官方语义 | 写 1 | 否 | 保留，不扩展、不据此写逻辑 | 不改 |
| 13 | `files` 含 `docs` | README 引用了 docs | 否 | 保留 | 不改 |
| 14 | SKILL frontmatter | name/description 已合规 | 否 | 保持 | 不改 |

---

## 7 上游贡献路径

- **通道现状**：外部 PR 关闭（`CONTRIBUTING.md:9`）；官方只留三条路——GitHub Discussions 报问题与投票、给插件仓打 `dsh-plugin` topic、写文章与答疑（`CONTRIBUTING.md:11-17`）。
- **PR 的礼仪（若通道打开或受邀）**：一个 PR 只做一件事、独立改动拆分（`AGENTS.md:165`）；标签要一个 `kind/*` 加所有相关 `area/*`（`:166`）；描述按 `dsh-pr-description` 规范写（`:167`）；测试段要描述行为而非正确性（`:156`）。
- **必须声明 AI 辅助**：PR 模板含独立 `## AI Usage` 段，要求填 `ai-declaration` 徽章与分级，并按 breakdown / design / testing / implementation / review 五个阶段写"级别 + AI 参与度 + 决策记录"（`.github/pull_request_template.md:20-34`）；Motivation 段要求引用同仓库 issue（`:3-5`）。
- **本仓的动作**：给 `dsh-patrol` 仓打 `dsh-plugin` topic；在 Discussions 发插件介绍，并就"包内 `skills/` 不被 filesystem provider 发现"这条规范空白提问（附最小复现）——这是当前唯一被官方明确欢迎的贡献形式。

---

### 本次未取证 / 不可用的来源

- `discussions/961` 正文：连接被重置，无官方域名搜索结果，本文不据其内容做任何断言。
- `manifestVersion` 的官方语义定义：在已读文档中未出现，本文只按"两仓都写 1、指南不要求"处理。
