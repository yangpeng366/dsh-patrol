# Policy v4：68 条 would-accept 的逐条定性，与「停跑」这条 Gate 规则

日期：2026-11-11 · 适用版本：`policyVersion: v4` · 依据：`patrol-decisions-20261110.jsonl`（未配白名单的那一轮）+ 2026-11-11 06:05 读取的方向表（rev 4402）

## 1. 数据、对齐与可复现

| 输入 | 是什么 | 落在哪 |
| --- | --- | --- |
| `patrol-decisions-20261110.jsonl` | 未配仓库白名单的一轮（Policy v2）：78 条决策，**68 条 would-accept** | `.artifacts/`（gitignore） |
| `patrol-decisions-20261110-v2.jsonl` | 同一张表加 15 个仓库前缀后的一轮（Policy v3）：78 条决策，**16 条 would-accept** | 同上 |
| 方向表 | `lark-cli base +record-list --as user --base-token Vb6pb5SJ4aWpEpsqPxvcR5Tqnte --table-id tbl2XGd8bO10NBY5 --page-size 100` → 78 行 | `.artifacts/direction/tbl2XGd8bO10NBY5_20261111_060500_289.ndjson`（不进仓） |

**先纠一处任务描述与文件的错位**：任务说明写的是「v2 日志里 78 条决策有 68 条 wouldAccept」，
但 68 这个数只在 `patrol-decisions-20261110.jsonl` 上成立；`-v2` 那份是加白名单之后重跑的，
would-accept 已经是 16。本文按 **68 条那份**逐条定性（它才是「只按 `next-step-present` 放行会放进什么」的证据），
`-v2` 那份只在 §4 用来对照 v4 重放的结果。两个文件都在 `.artifacts/`，`git status` 干净，没有进仓。

对齐方式：

- 日志的 `triggerId` 是 `trg_<record_id>_<hash>`，`threadKey` 是 `patrol:<record_id>`；两者解析出的 record_id
  在 78 条上完全一致（脚本核对，无一条只在一侧出现）。
- 日志与方向表 78 ↔ 78，**双向差集为空**：没有「只在日志」或「只在表」的行。
- 日志只记结论（`title` / `scope` / `rules`），不记 `下一步` / `当前阶段` / `巡检间隔` / `授权边界`。
  因此 §3 的这些列取**当前表值**（rev 4402）；日志里的 `scope`、`title` 用来核对行内容有没有漂移（§5）。

## 2. 判定口径（按任务给定口径执行，未放宽）

一个行只给一个判定，按下列顺序取第一个命中的：

| # | 判定 | 条件（结构化优先） | 落到 Gate 的哪个 reason |
| --- | --- | --- | --- |
| 1 | `excluded` | `巡检间隔(分钟)` 为 0 或空（停跑），或 `下一步` 为空 | `schedule-stopped`（v4 新增）/ `no-next-step` |
| 2 | `read-only` | `授权边界`=只读，或 `当前阶段`=维护且下一步只是复核/观察 | `read-only-direction`；观察类已由 `action-type` 事实覆盖（§6.2），结构化列仍缺（§7） |
| 3 | `approval` | `授权边界`=需审批，或下一步涉及现场部署/发布/密钥/生产配置/用户拍板 | `needs-approval`；其余由 `action-type` 事实逐类拒绝（§6.2） |
| 4 | `auto` | `授权边界`=自主，且 `仓库路径` 是真实存在的本地仓，且下一步是仓内可验证的代码/测试/文档改动 | 仓库白名单 + `repo-exists`（§6.1）+ `next-step-present` + `action-type`（§6.2）；结构化列与 `autonomousRepos` 仍缺（§7） |

「巡检间隔 0 = 停跑」不是本文的推断，是这张表自己的约定。`巡检占用` 列在三条行上把它写成了字：

- `reczz28TUTVTEBux`：`0=禁用巡检；…若要纳管健康巡检，把巡检间隔改为 1440（每日）`
- `recvwtYIV3rvD1`：`0=禁用巡检；先人工推进研究和文档。`
- `recvw6rvQKOTOF`：`0=禁用巡检；由父项 Jev 开源项目跟踪做 24h 汇总，本行只承接拆派与验收。`

`下一步` 里也有自述停跑的（`recvtR2SwGbGXn`「无后续轮巡…人工将巡检间隔从 0 恢复」、
`recvu7wY55xF0d`「巡检间隔 0（已停用）」、`recvu7x80TvxiM`「本行停跑中」）。旁证一致：
`recvuwiIQze18J` 的 `巡检占用` 写「spike 阶段不占定时巡检（手动触发…）」，其间隔同样是 0。

口径执行中的两处边界，写在这里而不是藏进表格：

1. **口径外的纯观察行**：`recvvQoJfFH1dY`（Jev 跟踪）阶段是「探索」（不是「维护」），
   下一步只有「盯 D1–D5 拍板与索引新增」。按口径第 2 条字面不命中，按第 4 条又无仓内改动。
   本文保守归 `read-only` 并注明，因为这行最坏也只是「读」。同类只有这一条。
2. **判定顺序会吞掉次要理由**：例如 `recvriLOrYiTkY`（networkx）既停跑、又涉及上游 PR 人工接手。
   表里给 `excluded`（口径第 1 条优先），但判据一句会写明「恢复后属 approval」，
   以免「停跑」这个理由把真正的风险盖掉。56 条 `excluded` 全都带这一句。

## 3. 68 条逐条

列说明：`scope` 取当前表的 `仓库路径`（日志里记过且不同的，用「（日志 …）」标出）；
`巡检间隔` 单位分钟，`空` 表示单元格为空；`最近结果` 取表的 `最近结果` 列，`（空）` 表示该格为空。

| # | record_id | 项目名 | scope（仓库路径） | 当前阶段 | 巡检间隔 | 授权边界 | 最近结果 | 判定 | 判据一句话 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `recvriLOrYiTkY` | networkx | D:\gitAll\networkx | 开发 | 0 | 自主 | 成功 | **excluded** | 巡检间隔=0（表内约定即停跑）；恢复后属 approval：下一步是盯上游 #9004/#8984 评论，上游禁 AI 代提、PR 只能人工接手。 |
| 2 | `recvriLOrYxRe4` | agent-cloud-harness | D:\gitAll\agent-cloud-harness | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步是 key 轮换与删除 .git.bak-*，涉及凭据与破坏性删除。 |
| 3 | `recvriLOrY7RIA` | fastjson2 | D:\gitAll\fastjson2 | 维护 | 0 | 只读 | （空） | **excluded** | 停跑；且现授权边界已改只读（日志当时按自主放行），本行属日志/表不一致，见 §5。 |
| 4 | `recvrXCvTCZZnv` | OpenEyes | E:\gitAll\openeyes | 验证 | 360 | 自主 | stale-thread | **approval** | 自主 + 实仓 + 360 分钟在跑，但下一步要先人工安装并启用 IDD 虚拟显示适配器再验第二桌面，属现场/人工前置。 |
| 5 | `recvsoUROVsJw4` | DeepSeek Harness (dsh) | D:\gitAll\dsh-superagent-prototype（DSH 本体未克隆；上游 https://github.com/deepseek-ai/deepseek-harness） | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；仓库单元格「路径+未克隆说明」混写，恢复后也判不了 auto。 |
| 6 | `recvsp1tyH4U3m` | 代码自动巡检/监听器 | D:\gitAll\auto-deploy | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 auto 候选：下一步是巡检写回重试契约与统一健康板，仓内代码可本地验证。 |
| 7 | `recvsp1tyH5vPi` | CCX 环境 | 02_部署运维/ccx配置与排查指南.md | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；仓库字段是 md 文档而非仓，恢复后只能 read-only（跑健康快照脚本并观察）。 |
| 8 | `recvsrhBJOxQzB` | OpenClaw / opencode 服务化集成 | （空） | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 approval：下一步要求先人工复核已保存的 Codex 输出。 |
| 9 | `recvsHOAmvVKKN` | dsh探索/贡献 | （空） | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后也不足 auto：`仓库路径` 空（`repo-empty-cell`，§6.1），须先补路径。 |
| 10 | `recvtcIOa5kYqH` | 宇宙学闭环 | D:\BaiduSyncdisk\Obsidian Vault\当前项目\02_项目推进\宇宙学接口化闭环研究.md | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；仓库字段是 vault 内的 md，恢复后 approval（先人工复核已保存输出）。 |
| 11 | `recvtcJ9QFAFdD` | dsh插件调研 | D:\gitAll\dsh-superagent-prototype（DSH 本体未克隆；上游 https://github.com/deepseek-ai/deepseek-harness） | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；下一步是「收口后仅条件更新」，恢复后 read-only。 |
| 12 | `recvtcJp44yxWN` | dsh升级/插件规划 | D:\gitAll\dsh-superagent-prototype（DSH 本体未克隆；上游 https://github.com/deepseek-ai/deepseek-harness） | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；仓库标注未克隆且无实仓，恢复后 approval：下一步含 push 与约束脚本推进。 |
| 13 | `recvtyseVt7jdh` | EchoBird | D:\gitAll\EchoBird | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval（先复核已保存的 Codex 输出再决定是否重跑）。 |
| 14 | `recvtR2SwGbGXn` | Video Battle | D:\BaiduSyncdisk\Obsidian Vault\当前项目\02_项目推进\Video Battle Yuri | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且下一步明写「无后续轮巡」，恢复后 read-only。 |
| 15 | `recvu7wY55xF0d` | 多媒体-测试 | （空） | （空） | 0 | 自主 | （空） | **excluded** | 停跑且下一步自述「巡检间隔 0（已停用）」，恢复后 read-only。 |
| 16 | `recvu7x80TvxiM` | 多媒体-发布 | D:\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且无 agent 可自推进项；恢复后 approval：待用户登录 45 端复核稿件列表。 |
| 17 | `recvu7x80T1Oy6` | 多媒体-热点 | D:\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要现场改 aed_naive_config_item、清 Redis 键与 prod yml，属生产配置。 |
| 18 | `recvu7y1Za7YXp` | 多媒体-选用 | D:\gitAll\articleeditor-tmp | 开发 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步需用户拍板后才触发 60 重建并现场复测。 |
| 19 | `recvu7y1ZaSM10` | 多媒体-稿库UI | D:\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 read-only：下一步是观察 HEAD 领先 origin 的 3 个 commit。 |
| 20 | `recvu7EHHHONbk` | BTV项目对接 | D:\项目对接\btv需求 | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 read-only：下一步只做 14 个跟踪文件的 SHA-256 复核。 |
| 21 | `recvugnuHED4gK` | sichuan-focus | D:\gitAll\articleeditor-tmp\sichuanfocusapp-mutilmedia-article | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要等用户授权 scp/sshpass 与容器重同步。 |
| 22 | `recvuwiIQze18J` | OpenEyes Record | D:\BaiduSyncdisk\Obsidian Vault\当前项目 | 开发 | 0 | 自主 | 成功 | **excluded** | 停跑；仓库字段指向 vault 而非 openeyes，恢复后 approval（真机窗口验证与仓库字段都需先改）。 |
| 23 | `recvuwvPwXiMQT` | articleeditor-webpack-漏洞修复 | D:\gitAll\articleeditor-tmp | 开发 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要重新构建 mchphone 并验证线上 bundle.js。 |
| 24 | `recvuwUETuVUFP` | MPD 审核任务重复排查与登录巡检 | （空） | 维护 | 空 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 read-only（只做 instanceId/productId 比对复核）。 |
| 25 | `recvuAVEyLRBrl` | 广播采访音频处理场景（BTV 数字员工） | （空） | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑且仓库路径为空；下一步是已完成工作的记录，恢复后 read-only。 |
| 26 | `recvuBBWTwVobU` | multimedia-agent-skill | E:\repos\gitAll\articleeditor-tmp\docs\multimedia-agent-skill | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 approval：下一步含 JWT 续期与等用户开 Edge 复测。 |
| 27 | `recvuBBWTwOEQH` | sichuanfocusapp-mutilmedia-article | D:\gitAll\articleeditor-tmp\sichuanfocusapp-mutilmedia-article | 验证 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 auto 候选：下一步是修 phase-07-save.md 并跑自检脚本，仓内可验。 |
| 28 | `recvuGGtWlYBOO` | 多媒体-稿件列表接口优化 | D:\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要现场确认 V1_280 生效并 DROP 索引，属生产配置。 |
| 29 | `recvuGRfRMTexB` | 多媒体稿上传-高码展示延迟 | D:\gitAll\articleeditor-tmp | （空） | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步明写「请用户决定是否授权提交修复」。 |
| 30 | `recvuHteD72BrV` | articleeditor修改轨迹 | （空） | 维护 | 空 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 approval（等发布闸门授权后再部署 60）。 |
| 31 | `recvuHteD7SE4V` | articleeditor 选稿版本继承 | （空） | 维护 | 空 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 approval（60 环境部署后验证选稿版本继承）。 |
| 32 | `recvuIj52aeBBU` | articleeditor 推送前正文表达式支持 | D:\gitAll\articleeditor-tmp | 开发 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 auto 候选：下一步是 editor 全量编译 + 处理器单测 + 日志脱敏，仓内可验（测试环境验证段另需现场）。 |
| 33 | `recvuNYpwFcoyx` | 巴中方正云雀-见报成品接入预研 | E:\repos\gitAll\sns-cce2 | 开发 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要现场进 /newspaper/sample 验证大样。 |
| 34 | `recvuOzY5dp9MR` | session-memory-curator | D:\BaiduSyncdisk\Obsidian Vault\当前项目 | （空） | 720 | 自主 | stale-thread | **approval** | 自主 + 实仓 + 720 分钟在跑，但下一步要等 A/B/C 批复后把含 ActiveMQ 凭证的事实升级成 note/MEMORY，属用户拍板 + 凭据。 |
| 35 | `recvv0TxKLm7gh` | patrol-scaffold 开源脚手架 | D:\gitAll\patrol-scaffold | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 auto 候选：下一步是 intervalMin 调度修正与 0.3 安装哈希核对，仓内可验（凭据实跑段另需审批）。 |
| 36 | `recvvbqEHseF3j` | 编辑器账号过期扫码弹框 | D:\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且无自推进项；恢复后 approval（待用户用 admin 账号复核弹框）。 |
| 37 | `recvvbMnK1j2A3` | APE 文案创作接入 /Editor | D:\gitAll\articleeditor-tmp | 维护 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要改 moc.akrt.cn 配置并重启复测，属生产配置。 |
| 38 | `recvvNWh9u3lQZ` | agent-cloud-harness / OpenEyes UI 自动化接入 | D:\gitAll\agent-cloud-harness | 开发 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 read-only：下一步是 19 天无增量的状态复盘。 |
| 39 | `recvvQoJfFH1dY` | Jev 开源项目跟踪 | D:\gitAll\awesome-jev | 探索 | 1440 | 自主 | stale-thread | **read-only** | 自主 + 实仓 + 1440 分钟在跑，但下一步只有盯 D1–D5 拍板与索引新增，不改仓。 |
| 40 | `recvw6rvQKOTOF` | Jev 决策模式吸收清单 | D:\gitAll\awesome-jev | 探索 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 read-only：下一步是对照 ACH/OpenEyes/Jev 做评估，先给最小验证再谈拆任务。 |
| 41 | `recvw7SVIEOwBh` | 个人稿库提交追回逻辑 | E:\repos\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；下一步已标 RETIRE、不再排巡检，恢复后 read-only。 |
| 42 | `recvw8ho1Igwny` | articleeditor 高级检索稿库范围配置 | E:\repos\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；下一步自述「已完成 / 巡检已停」，恢复后 read-only。 |
| 43 | `recvw8jX2lIJ3q` | 多媒体-个人稿库桥接共享稿库 | E:\repos\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | 通过 | **excluded** | 停跑；恢复后 approval：下一步是 60 环境同步上线并复跑验收脚本。 |
| 44 | `recvwtXyeKiM98` | codex-ccx-portable | D:\gitAll\codex-ccx-portable | 维护 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要在新机验官方下载 + bootstrap + Nginx 8443 链路，属现场。 |
| 45 | `recvwtYIV3rvD1` | 灵活 Agent 编排与云 Runtime | D:\gitAll\pi-agent-cloud | 推进中 | 0 | 自主 | 成功 | **excluded** | 停跑；仓库路径 D:\gitAll\pi-agent-cloud 已不在盘上，恢复后 approval：需另一台 Docker 机与 provider key 轮换。 |
| 46 | `recvwuSTYb28w0` | AI理论→密码/物理/材料/网络应用雷达 | （未克隆）https://github.com/yangpeng366/ai-theory-app-radar | 推进中 | 360 | 自主 | 成功 | **approval** | 自主但仓库标注「未克隆」、无本地实仓，下一步要重取约 21 MB 语料，属人工确认的资源动作。 |
| 47 | `reczz28KoA4Q5UE9` | 草原云内容理解（稿件文章理解-文本智能能力） | E:\repos\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 approval：等密钥、ConfigMap 与 helm values 就绪（行内已写「阻塞停巡」）。 |
| 48 | `reczz28MPstPVjaf` | minimax-code | E:\repos\gitAll\minimax-code | 维护 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要先 mcode login（凭据）再通读源码。 |
| 49 | `reczz28MPstPUO1y` | OpenAgentCore | E:\repos\gitAll\OpenAgentCore | 维护 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 read-only：下一步是通读协议写对比笔记，行内明写「不动手」。 |
| 50 | `reczz28NeYXnjL5p` | （BTV 定制）ARTC 业务消息总线扩展 | E:\repos\gitAll\articleeditor-tmp | 探索 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 auto 候选：下一步是 editorBase 模块代码 + 事件 + 文档，仓内可验。 |
| 51 | `reczz28P786xqawA` | 群组稿库审核与自动签发 (articleeditor-tmp) | E:\repos\gitAll\articleeditor-tmp | 维护 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要现场升级 amd64/arm64 安装包后复测。 |
| 52 | `reczz28QOfrbeaIn` | 巡检执行方式改造（三形态 + 双执行器） | D:\BaiduSyncdisk\Obsidian Vault\当前项目 | 开发 | 1440 | 自主 | 成功 | **approval** | 自主 + 实仓 + 1440 分钟在跑（协作形态 approve），但下一步要定「阻断时是否落报告」口径并盯上线首轮日志，属拍板 + 跨仓。 |
| 53 | `reczz28QTKcOv7Tq` | MPD 移动端火山审核剩余定制与 60 环境发布生效巡检 | D:\gitAll\mpd | 发布准备 | 1440 | 自主 | stale-thread | **approval** | 自主 + 实仓 + 1440 分钟在跑，下一步是执行 60 发布并跑 release-verify，属发布。 |
| 54 | `reczz28QkmRdCFEv` | 远程接入与现场环境准备（内网优先） | D:\BaiduSyncdisk\Obsidian Vault\当前项目 | 探索 | 1440 | 自主 | stale-thread | **approval** | 自主 + 1440 分钟在跑，下一步要回办公现场连内网、跑探测与 ssh-keyscan，属现场。 |
| 55 | `reczz28QlJEjtOYY` | MPD App OA登录页 | E:\repos\gitAll\mpd + E:\repos\gitAll\mpd-front | 发布准备 | 0 | 自主 | 成功 | **excluded** | 停跑；仓库路径写成两仓相加且不存在，恢复后 approval：现场换镜像 + 执行配置 SQL。 |
| 56 | `reczz28Ru8Le1hfS` | XERJ 检索层吸收（本地搜索 + System One） | E:\AI-Portable\xerj-data | 开发 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 approval：下一步要改 ~/.codex 配置、下载权重并对 Corpus Hub 取数。 |
| 57 | `reczz28RzGKBlSEf` | OpenEyes 质量门禁与价值驱动 | E:\gitAll\openeyes | 开发 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 auto 候选：门禁/契约/脚本可本地验，视觉档接真模型应另立行按厂商依赖判。 |
| 58 | `reczz28SKDwSQkl9` | ziwei-network-analyst | D:\gitAll\ziwei-network-analyst（日志 （未克隆）https://github.com/yangpeng366/ziwei-network-analyst） | 维护 | 1440 | 自主 | 成功 | **read-only** | 自主 + 实仓 + 1440 分钟在跑，但下一步只是「随上游或语料变化维护」；日志里本行 scope 仍是未克隆 URL，属日志/表不一致。 |
| 59 | `reczz28SSxObE9Ec` | 多媒体-登出串号 | E:\repos\gitAll\articleeditor-tmp | 开发 | 1440 | 自主 | stale-thread | **approval** | 自主 + 实仓 + 1440 分钟在跑，但下一步要现场导 pod 日志，并含待用户拍板的跨仓动作。 |
| 60 | `reczz28T4BtdsrI6` | 文稿智能工作台（独立写稿模块 + CLI skill） | D:\gitAll\manuscript-writer | 验证 | 60 | 自主 | stale-thread | **approval** | 自主 + 实仓 + 60 分钟在跑，下一步是拍板后发 0.15.2 并线上复验，属发布。 |
| 61 | `reczz28TAm3Gctb3` | 文稿智能工作台（manuscript-writer） | D:\gitAll\manuscript-writer | 验证 | 0 | 自主 | 成功 | **excluded** | 停跑；恢复后 approval：下一步等用户验收 1.3.4，持久安装受组织策略影响。 |
| 62 | `reczz28TB1zmhMhz` | 流程引擎联调支持（辅助AI 开发） | D:\gitAll\bpm-mvp | 推进中 | 1440 | 自主 | 成功 | **approval** | 自主 + 实仓 + 1440 分钟在跑，但下一步要注入 AppKey、跑真实密钥并改 45/60 env 与 Helm，属密钥 + 生产配置。 |
| 63 | `reczz28TUTVTEBux` | X240 辅助机（CCX 代理 + 出差内网跳板） | （空） | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 approval：唯一待人工一步是 Tailscale 管理台勾路由。 |
| 64 | `reczz28VAJ2lYf2L` | 昭通日报-方正数字报大样接入 | D:\gitAll\articleeditor-tmp | 验证 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要现场提供方正接口地址与鉴权口径。 |
| 65 | `reczz28WNo4XHAT6` | articleeditor MCH 组稿同步 | D:\gitAll\articleeditor-tmp | 验证 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要取得 MCH S8 有效账号/令牌，并在 45 现场跑迁移。 |
| 66 | `reczz28XYTeBuq2R` | 多媒体-版面审核权限 | E:\repos\gitAll\articleeditor-tmp | 开发 | 0 | 自主 | （空） | **excluded** | 停跑；恢复后 auto 候选：下一步是后端编译 + 前端检查 + 场景验证并提交，本轮不部署。 |
| 67 | `reczz28Xok2p6wwg` | articleeditor MCH 图文稿素材重新入库 | D:\gitAll\articleeditor-tmp | 开发 | 空 | 自主 | （空） | **excluded** | 停跑；恢复后 approval：下一步要取真实样本在 45 现场跑迁移入库。 |
| 68 | `reczz28XopBpg9xU` | dsh-patrol 插件（方向表 → DSH Source） | D:\gitAll\dsh-patrol | 发布准备 | 1440 | 自主 | 成功 | **approval** | 自主 + 实仓 + 1440 分钟在跑，但下一步第二项是 npm 发布待 token/口径拍板；第一项（本文与 Policy 规则）已是仓内可验改动。 |

## 4. 分布与计数（脚本核对，不手数）

```
auto        0
approval   10
read-only   2
excluded   56
合计       68
```

`excluded` 的 56 条全部是「停跑」这一条命中的：44 条 `巡检间隔=0`、12 条为空；
没有任何一条是因为 `下一步` 为空（那条 `no-next-step` 的行 `reczz28SKnliHK45` 在日志里本来就被拒了，不在 68 条里）。
按「恢复巡检之后」再看这 56 条：**7 条可达 auto**（判据里写明「恢复后 auto 候选」，且在 §6.1 里过了 `repo-exists`）、
33 条仍属 approval、13 条为 read-only、3 条要先修字段（`recvriLOrY7RIA` 授权已转只读、`recvsoUROVsJw4`
仓库单元格混写、`recvsHOAmvVKKN` 仓库为空）。7 + 33 + 13 + 3 = 56。

原来的 8 条 auto 候选里，`recvsHOAmvVKKN` 的 `仓库路径` 是空单元格，`repo-exists` 把它从候选里划掉：
「恢复后可达 auto」从 8 条降到 **7 条**，不是判据变严，而是终于有事实能证明这件事。

这 12 条非 excluded 的行就是全部「在跑的」行，也是 v4 下唯一还会进入 Assessment 的 12 条：
`recvrXCvTCZZnv`、`recvuOzY5dp9MR`、`recvvQoJfFH1dY`、`recvwuSTYb28w0`、`reczz28QOfrbeaIn`、
`reczz28QTKcOv7Tq`、`reczz28QkmRdCFEv`、`reczz28SKDwSQkl9`、`reczz28SSxObE9Ec`、`reczz28T4BtdsrI6`、
`reczz28TB1zmhMhz`、`reczz28XopBpg9xU`。

### 与 `policy-audit` 的关系：日志的数是「当时」的，重放的数是「现在」的

`scripts/policy-audit.mjs` 只读日志，**不会因为规则变化而改数**：

```
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110.jsonl --json
  → total 78, observed 68, ignored 10, wouldAccept 68
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110-v2.jsonl --json
  → total 78, observed 16, ignored 62, wouldAccept 16
```

68 与本文的「68 条」对得上；16 与 `docs/policy-v3-allowlist.md` §3 的「16 条」对得上。
**会变的是「拿当前表重放一遍」的结果**，因为 v4 多了一层 `schedule-stopped`：

| 重放对象 | 日志记录 | v4 重放：`schedule-stopped` | v4 重放：仍 would-accept |
| --- | --- | --- | --- |
| `patrol-decisions-20261110.jsonl`（68 条） | 68 | **56** | **12** |
| `patrol-decisions-20261110-v2.jsonl`（16 条） | 16 | **12** | **4** |

差的 56 条就是本文判 `excluded` 的那 56 条；v2 那份从 16 掉到 4，原因是它的 16 条里同样只有 4 条
间隔为正（`recvrXCvTCZZnv`、`recvvQoJfFH1dY`、`reczz28T4BtdsrI6`、`reczz28XopBpg9xU`）。
这不是「工作变少了」，而是 v4 不再把「表里明写停跑」的行算成「可自主」。

下面的机器可读块由 `scripts/policy-triage-check.mjs` 用同一份日志与表重新算一遍后比对；
它同时核对逐条表的覆盖、判定词表，以及口径里可结构化的那几条（`policy-triage-check` 的 `table:structure`）。

```triage-summary
total=68
auto=0
approval=10
read-only=2
excluded=56
replay-v1-schedule-stopped=56
replay-v1-would-accept=12
replay-v2-schedule-stopped=12
replay-v2-would-accept=4
```

## 5. 日志/表不一致（不硬猜，单独列出）

脚本拿日志里的 `title`、`scope` 与当前表比对，78 条里只有 1 条 scope 漂移；另外 1 条的授权字段在
11-10 之后被改过（日志不记授权字段，靠「日志判为可放行、现表却是只读/需审批」反推）。两条都按
**当前表**定性，并在 §3 的判据里写明，同时列在这里：

| record_id | 项目名 | 日志当时 | 当前表 | 怎么处理 |
| --- | --- | --- | --- | --- |
| `recvriLOrY7RIA` | fastjson2 | 按「自主 + 有下一步」进入 would-accept | `授权边界`=只读，`下一步`写「本行转只读留档，不再派工」 | 判 `excluded`（停跑优先），标注「恢复后只读」；本机 `D:\gitAll\fastjson2` 不存在 |
| `reczz28SKDwSQkl9` | ziwei-network-analyst | `scope` = `（未克隆）https://github.com/yangpeng366/ziwei-network-analyst` | `仓库路径` = `D:\gitAll\ziwei-network-analyst`（本机存在） | 判 `read-only`（下一步只是随上游维护）；scope 列同时标出日志值与现值 |

除这两条外，其余 66 条的 `title` 与 `scope` 与当前表一致，没有「日志里有、表里没有」的行，
也没有「表里有、日志没判过」的行。

顺带记一笔**结构性问题**（不是不一致，是字段质量）。这一段不再手数：`inspectRepoPath()` 对 68 条逐格重读一次，
结果如下（§6.1 有同一模块对 8 条候选的明细）：

| 结论 | 条数 | 是哪几条 |
| --- | --- | --- |
| `repo-exists-ok`（一个可达目录） | 50 | — |
| `repo-empty-cell`（单元格为空） | 8 | `recvsrhBJOxQzB`、`recvsHOAmvVKKN`、`recvu7wY55xF0d`、`recvuwUETuVUFP`、`recvuAVEyLRBrl`、`recvuHteD72BrV`、`recvuHteD7SE4V`、`reczz28TUTVTEBux` |
| `repo-path-ambiguous`（一格多义） | 4 | 路径后接注释：`recvsoUROVsJw4`、`recvtcJ9QFAFdD`、`recvtcJp44yxWN`；两仓相加：`reczz28QlJEjtOYY` |
| `repo-missing`（目录已不在） | 3 | `recvriLOrY7RIA`、`recvtR2SwGbGXn`、`recvwtYIV3rvD1` |
| `repo-path-relative-unresolved`（相对路径，无基准） | 1 | `recvsp1tyH5vPi` |
| `repo-not-a-directory`（是文件） | 1 | `recvtcIOa5kYqH` |
| `repo-not-cloned`（单元格自带未克隆标记） | 1 | `recvwuSTYb28w0` |

```triage-repo-tally
records=68
reason-repo-exists-ok=50
reason-repo-empty-cell=8
reason-repo-path-ambiguous=4
reason-repo-missing=3
reason-repo-path-relative-unresolved=1
reason-repo-not-a-directory=1
reason-repo-not-cloned=1
```

三处要分开看，它们以前被同一句「不可探测」混在一起：

1. **混写不是不存在**。`recvsoUROVsJw4`、`recvtcJ9QFAFdD`、`recvtcJp44yxWN` 指向的目录其实在盘上，
   是同一格里又跟了「（DSH 本体未克隆；上游 …）」。旧口径说「探测失败」，新事实说「目录在，但这格同时说了别的」
   （`repo-path-ambiguous`，`candidates[0].annotation` 保留原话）。
2. **vault 目录是目录**。`recvuwiIQze18J`、`reczz28QOfrbeaIn`、`reczz28QkmRdCFEv` 指向 Obsidian vault，
   存在性事实为真（`repo-exists-ok`）；它们不是**代码仓**，那件事 `repo-exists` 证明不了，仍归白名单与动作类型。
3. **「不在盘上」有三条**。`recvwtYIV3rvD1`（`pi-agent-cloud`）在 §3 里已是停跑，`recvriLOrY7RIA`（fastjson2）
   与 `recvtR2SwGbGXn`（Video Battle Yuri）同样。停跑既已拦住它们，`repo-missing` 是恢复巡检后的第二道。

这就是 §7 里「仓库路径需要一个纯路径列」的由来：`auto` 的最后一道判据是「真实存在的本地仓」，
`repo-exists` 现在能回答「这一格是不是一个可达目录」，但回答不了「是不是这一格的仓」。

## 6. 代码落点：两条事实 + 一层仓库判定，其余复用

| §2 判定 | 由谁决定 | 状态 |
| --- | --- | --- |
| `excluded`（巡检间隔 0/空） | `schedule-stopped` | **v4 新增** |
| `excluded`（`下一步` 为空） | `no-next-step` | v3 已有 |
| `read-only`（`授权边界`=只读） | `read-only-direction` | v3 已有 |
| `read-only`（维护 + 只复核/观察） | `action-type` 事实：`unclear`（无行动）或非仓内类型 | **v4 新增**（§6.2） |
| `approval`（`授权边界`=需审批） | `needs-approval` | v3 已有 |
| `approval`（现场/发布/密钥/生产配置/拍板） | `action-type` 事实：`action-field-ops` / `action-release` / `action-needs-secret` / `action-needs-config` / `action-needs-decision` | **v4 新增**（§6.2） |
| `auto` | 仓库白名单 + `repo-exists` + `next-step-present` + `action-type`；仍缺结构化列，见 §7 | 部分（`repo-exists` 与 `action-type` 已在同一 v4 内补齐，§6.1 / §6.2） |

具体改动（`src/`）：

1. `DirectionFacts.intervalMin`：新的结构化事实，来自 `巡检间隔(分钟)`，经 `itemFacts()` 写入 Trigger。
   `0` 与空都归一成 `0`（`normalizeItem()` 原本就这么折），Gate 只看「是否为正数」。
2. `DirectionPolicy.gate()` 新增第一道行级拒绝：
   ```
   paused → no-direction-facts → schedule-stopped → 审批状态 → 授权边界 → 下一步 → 仓库层（白名单 → 存在性）→ ticket 层
   ```
   `schedule-stopped` 排在审批/授权之前，是因为「为什么这行没动」只有一个第一答案：它停跑了。
   这也让 §4 的 `excluded` 计数与重放里 `schedule-stopped` 的计数逐条相等。
   **缺事实同样拒绝**（不是因为它一定停跑，而是因为没写的巡检间隔和没配的白名单一样，属于「忘了配」，
   不是许可 —— 与 v3 的 `repo-allowlist-unset` 同一条理由）。
3. `itemFingerprint()` 纳入 `intervalMin`：否则「停跑 → 恢复」不会产生新 Trigger，
   `receive()` 会把它当成重复事件，Gate 永远看不到新间隔。代价是升级后所有行的一次性重算（§9）。
4. `Config.policyVersion` 默认 `v3` → `v4`；`inferredRules` **不变**，仍是 `['next-step-present']`。
   理由：这 68 条里 `auto` 是 0 条，没有任何一组规则名够格被「自主接受」；v4 只收紧，不放宽。
5. `acceptMode` 默认仍是 `observe`，**没有切成 auto**。本文证明的是「谁会进 Assessment」，
   不证明「进了之后会安全执行」。
6. `src/core/repo-facts.ts`（新）+ `DirectionFacts.repoExists`：`仓库路径` 单元格由 `inspectRepoPath()`
   读成 `exists / kind / normalizedPath / reason / candidates`，挂到事实里。Gate 在仓库层的白名单之后
   读它：`reason !== 'repo-exists-ok'` 就拒，reason 原样进决策日志（`repo-missing`、`repo-path-ambiguous`、
   `repo-empty-cell`、`repo-path-unreachable`、`repo-not-a-directory`、`repo-not-local-path`、
   `repo-not-cloned`、`repo-path-relative-unresolved`）；事实缺失报 `repo-exists-unknown`，与
   `repo-allowlist-unset` 同一条理由——没写下的不算是许可。
7. `itemFingerprint()` 纳入「仓库是否存在」（`exists` / `missing`）：否则把仓克隆下来之后，
   `receive()` 会把重新判定当成重复事件，一次 `repo-missing` 永远无法变成通过。

策略本身没有变聪明：它没有去读 `下一步` 的自然语言。停跑、只读、需审批、无下一步、仓库白名单、
仓库是否存在都是结构化字段；剩下的两件事（现场/发布/密钥/拍板、仓内可验证改动）如实写进 §7，
实仓存在性已落成 `repoExists`，下一节是它的口径与实测。

### 6.1 `repo-exists`：口径、代码与 8 条候选的实测

`src/core/repo-facts.ts` 把 `仓库路径` 的**原始单元格**读成一个事实：

| 字段 | 含义 |
| --- | --- |
| `exists` | 单元格指向的那一个路径在盘上是否存在（文件也算存在，`kind` 说明是什么） |
| `kind` | `directory` / `file` / `other` / `missing` / `unreachable` / `empty` / `multiple` / `url` / `unresolved` |
| `normalizedPath` | 绝对化、规范化后的路径（盘符大写、分隔符统一、去尾部分隔符）；无单一指向时为 `''` |
| `reason` | Gate 直接当拒绝理由用；只有 `repo-exists-ok` 是通过值 |
| `candidates` | 每个路径片段的 `path / kind / exists / annotation`，供审计 |

fail-closed 的边界，逐条写成代码而不是猜：

- **多行、分号（`;`/`；`）、顿号（`、`）、空格式 ` + `** 切开后仍多于一个不同路径 ⇒ `repo-path-ambiguous`；同一路径写两次不算歧义。
  分隔符在括号内不生效，所以 `（DSH 本体未克隆；上游 …）` 不会被切成两个候选。
- **带说明文字**：路径后跟 `（`、`；`、`：`、`,` 等 ⇒ `repo-path-ambiguous`，但 `exists/kind/normalizedPath`
  照实报告那条路径（“目录在，只是这一格还说了别的”）。
- **相对路径**：没有基准目录就 `repo-path-relative-unresolved`，绝不把 `02_部署运维/…` 猜成巡检进程的 cwd。
- **文件而非目录**：`exists: true` + `repo-not-a-directory`，两者不混淆。
- **不可达**（断开的 `E:`、`EPERM` 等）与**不存在**分开：`repo-path-unreachable` vs `repo-missing`。

8 条「恢复后 auto 候选」的实测（同一模块、同一份表，由 `scripts/policy-triage-check.mjs` 重算）：

| # | record_id | 项目名 | 仓库路径（原始单元格） | exists | kind | reason |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `recvsp1tyH4U3m` | 代码自动巡检/监听器 | `D:\gitAll\auto-deploy` | true | directory | repo-exists-ok |
| 2 | `recvsHOAmvVKKN` | dsh探索/贡献 | （空） | false | empty | repo-empty-cell |
| 3 | `recvuBBWTwOEQH` | sichuanfocusapp-mutilmedia-article | `D:\gitAll\articleeditor-tmp\sichuanfocusapp-mutilmedia-article` | true | directory | repo-exists-ok |
| 4 | `recvuIj52aeBBU` | articleeditor 推送前正文表达式支持 | `D:\gitAll\articleeditor-tmp` | true | directory | repo-exists-ok |
| 5 | `recvv0TxKLm7gh` | patrol-scaffold 开源脚手架 | `D:\gitAll\patrol-scaffold` | true | directory | repo-exists-ok |
| 6 | `reczz28NeYXnjL5p` | （BTV 定制）ARTC 业务消息总线扩展 | `E:\repos\gitAll\articleeditor-tmp` | true | directory | repo-exists-ok |
| 7 | `reczz28RzGKBlSEf` | OpenEyes 质量门禁与价值驱动 | `E:\gitAll\openeyes` | true | directory | repo-exists-ok |
| 8 | `reczz28XYTeBuq2R` | 多媒体-版面审核权限 | `E:\repos\gitAll\articleeditor-tmp` | true | directory | repo-exists-ok |

```triage-repo-exists
candidates=8
reason-repo-exists-ok=7
reason-repo-empty-cell=1
still-auto=7
```

结论三句：

1. **8 → 7**。唯一没过的 `recvsHOAmvVKKN` 是空单元格（`repo-empty-cell`）：不是路径写错，是根本没写。
   补上路径之前它进不了 auto，也不能靠「须先补仓库路径」这种注释放行。
2. **过的 7 条只是过了仓库层**。`still-auto` 用的是 §2 第 4 条里可结构化的部分（自主 + 有下一步 +
   一个可达目录），**不含**部署侧的 `autonomousRepos` 覆盖，也不含「下一步是不是仓内可验证改动」。
   所以它不等于「7 条 auto」，只是「7 条不再因为仓库不存在被拒」。
3. **证明得了存在，证明不了归属**。`E:\repos\gitAll\articleeditor-tmp` 是目录，但不是「这两行的仓」：
   8 条候选里 `reczz28NeYXnjL5p` 与 `reczz28XYTeBuq2R` 指向同一个路径，更早的行里还有十几条也指向它。
   归属仍是人的事，`repo-exists` 只把「路径写没写、在不在」变成事实。

### 6.2 `action-type`：动作类型、代码与 78 行的实测

`src/core/action-facts.ts` 把一行方向表的**六个已有单元格**读成一个事实：`下一步` / `简要描述` /
`用户批注` / `授权边界` / `贡献类型` / `审批状态`。

| 字段 | 含义 |
| --- | --- |
| `kind` | `repo-code` / `repo-test` / `repo-doc` / `field-ops` / `release` / `secret` / `config` / `decision` / `unclear` |
| `matched` | 命中的词（去重，按词表顺序） |
| `evidence` | 命中的原句片段，空白折叠，不超过 80 字 |
| `field` | 证据来自哪一格（表格自己的列名） |
| `reason` | 为什么是这个 kind；`unclear` 时写明缺哪一格的什么 |
| `alternatives` | 其余也命中的 kind，按最严在前，供审计 |

准入与拒绝的规矩是**不对称**的，写成代码而不是猜：

- **准入只认 `下一步`**。`简要描述` 是题目不是动作（"机构 API Key 存 DB" 说的是这个仓是什么，
  不是这一步要 key），`用户批注` 是历史流水（只用来发现「还在等人拍板」的话）。所以 `用户批注` 里的
  「代码」永远不能让一行通过。
- **拒绝可以来自任何一格**。密钥 / 现场 / 发布 / 配置 / 拍板，任一格里出现就够了。
- **最严者胜**：secret → field-ops → config → release → decision → repo-code → repo-test → repo-doc。
  「代码已就位，等用户拍板」是 `decision`，不是 `repo-code`。
- **没有证据就是 `unclear`**，绝不默认 `repo-code`：观察结论（「复核完成，无漂移」）、英文模板句、
  空格子都落在这里，`reason` 写明缺什么。

78 行的实测（同一模块、同一份表，由 `scripts/policy-triage-check.mjs` 重算）：

```triage-action
records=78
kind-unclear=19
kind-secret=12
kind-decision=11
kind-field-ops=10
kind-release=10
kind-repo-code=9
kind-repo-doc=3
kind-repo-test=2
kind-config=2
```

结论三句：

1. **仓内可验证的改动只有 14 行**（repo-code 9 + repo-test 2 + repo-doc 3）。`unclear` 19 行占了四分之一，
   那些行写的是「复核完成，无漂移」这样的观察结论 —— 它们本来就不该被当成「下一步」。
2. **45 行在动作层就被拒**（secret 12 + field-ops 10 + release 10 + config 2 + decision 11）。这些行过去要靠
   人读 `下一步` 才看得出「这不是无人值守能做的」，现在有机器可复算的理由：`action-needs-secret` /
   `action-field-ops` / `action-release` / `action-needs-config` / `action-needs-decision`。
3. **这仍是事实，不是许可**。事实带 evidence，Gate 只在有证据时才拒（缺证据 = `unclear` = 拒），不因为
   「看着像仓内」就放行；但它是从自由文本推的，词表会漏（「去 45 环境看一眼」判 field-ops，
   「回头看一眼」不判），也会把「这步要发版」藏在别的说法里漏判。要彻底消除这类误判，仍需方向表新增
   结构化「动作类型」列（§7），届时本模块降级为该列的预填工具。

## 7. 需要新增事实（当前 Policy 拿不到，未偷偷降级）
| 缺的事实 | 谁产 | 用在哪 | 不补的后果 |
| --- | --- | --- | --- |
| `repoExists`（存在且是目录） | **已落地**：`inspectRepoPath()`，`itemToTrigger()` 每轮探测一次，写进 `DirectionFacts`（§6.1） | `auto` 的「真实存在的本地仓」 | 已补齐；它只证明「这一格是一个可达目录」，不证明「是 git 仓 / 是本行的仓」（§9.4） |
| 动作类型（代码/测试/文档 vs 现场/发布/密钥/配置/拍板） | **已落地（事实版）**：`inspectAction()`，`itemToTrigger()` 每轮算一次，写进 `DirectionFacts`（§6.2）；方向表新增结构化列仍待补 | `auto` 的「下一步是仓内可验证的改动」 | 词表漏判仍在；结构化列到位后本模块降级为预填工具（§6.2 结论 3） |
| 纯路径列（与注释分开） | 方向表 | 同上 | 「路径 + 注释」混写让存在性探测误判（3 条样本） |
| 「观察」标记 | 方向表 | `read-only`（维护 + 只复核） | 口径第 2 条后半句无法结构化，只能人判 |
| 巡检间隔「0」与「空」的区分 | 方向表 / `normalizeItem` | 审计可读性 | 两者都拒绝（fail-closed），但日志里分不清「明确停跑」与「忘了填」 |

在这些事实到位之前，`auto` 只能由人工逐行确认 —— 这也正是 v4 之后 `auto` 仍为 0 的直接原因，
不是「没有可自主的工作」，而是「可自主这件事还不能只靠现有字段证明」。

`repo-exists` 与 `action-type` 都已在同一 v4 内补齐（§6.1 / §6.2）：前者证明「有一个可达目录」，
后者把「下一步是仓内可验证的改动」从人读口径变成带证据的事实。剩下的缺口是**结构化列**（方向表的
「动作类型」与「纯路径」两列）与 `autonomousRepos` 覆盖。`acceptMode` 仍是 `observe`，`auto` 仍是 0 ——
事实到位不等于许可到位。

## 8. 验证

```
pnpm typecheck                      clean
pnpm test                           15 files / 167 tests passed
pnpm build                          ok
node scripts/release-check.mjs      RESULT: PASS（8/8 必需文件、无禁入内容、解包 CLI 自检、版本一致）
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110.jsonl --json
                                    total 78, observed 68, ignored 10, wouldAccept 68
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110-v2.jsonl --json
                                    total 78, observed 16, ignored 62, wouldAccept 16
node scripts/policy-triage-check.mjs --table .artifacts/direction/tbl2XGd8bO10NBY5_20261111_060500_289.ndjson
                                    table:coverage 68/68 · table:verdicts ok · table:structure ok ·
                                    repo:table 8/8 · repo:counts 8 candidates / 7 ok / 1 empty / still auto 7 ·
                                    repo:tally 68 records（50 ok / 8 empty / 4 ambiguous / 3 missing /
                                    1 relative / 1 file / 1 not-cloned）·
                                    action:counts 78 rows（unclear 19 / secret 12 / decision 11 /
                                    field-ops 10 / release 10 / repo-code 9 / repo-doc 3 / repo-test 2 /
                                    config 2）· summary:counts ok · RESULT: PASS
```

新增/调整的断言：

- `tests/repo-facts.spec.ts`（新，19 例）：目录 / 正斜杠与尾分隔符 / UNC / POSIX / 数组单元格 / 同一路径写两次 ⇒
  `repo-exists-ok`；空、`null`、全空白、空数组、两个仓相加、换行两路径、路径后接注释 ⇒ 各自 reason；
  `（未克隆）https://…` 不探测就拒；相对路径无基准 ⇒ `repo-path-relative-unresolved`，给基准则解析并探测；
  文件 / `other` ⇒ `repo-not-a-directory`；缺路径 ⇒ `repo-missing`；`EPERM` ⇒ `repo-path-unreachable`；
  真实临时目录、目录里的文件、不存在的路径三例走默认 `statSync`。
- `tests/policy.spec.ts`：只在一个可达目录上放行；缺事实 ⇒ `repo-exists-unknown`；六种 reason 原样透传；
  `reason=ok` 但 `exists=false` 仍被拒（事实自相矛盾不得放行）；存在性在 ticket 层之前（`repo-missing` 优先于
  `ticket-already-open`）。原有用例的 facts 补上 `repoExists`，不再依赖“没有事实也放行”。
- `tests/mapping.spec.ts`：`facts.repoExists` 来自探测而非路径形状；空单元格 ⇒ `repo-empty-cell`；
  `baseDir` + 注入 probe 的路径按预期拼出；仓库从无到有 ⇒ 指纹不同。
- `tests/runner.spec.ts`：造行的 `repoPath` 改成它自己创建的临时目录（原来写死的 `D:\gitAll\demo` 不存在，
  现在会被 `repo-missing` 拦住）；`tests/engine.spec.ts`、`tests/decision-log.spec.ts`、
  `scripts/same-repo-rehearsal.ts` 造 facts 时补上 `repoExists`。
- `tests/action-facts.spec.ts`（新，28 例）：每个 kind 各有真实行样本；`用户批注` 里的「代码」不能准入，
  `简要描述` 也不能；「代码已就位，等用户拍板」判 `decision`；否定句（"不用密钥"）不判 secret；
  英文模板句与空格子判 `unclear` 且 `reason` 指明缺什么；`alternatives` 按最严在前；
  `latest` 里的 `test` 不算测试（ASCII 词边界）。
- `tests/policy.spec.ts`（新增动作层 6 例）：code/test/doc 三种仓内动作放行；`action=secret` ⇒
  `action-needs-secret`；每种非仓内 kind 各有独立理由；缺 `actionFacts` ⇒ `action-facts-unknown`；
  `kind=repo-code` 但 `matched` 为空 ⇒ `action-unclear`（事实自相矛盾不得放行）；动作层排在仓库层之后、
  ticket 层之前。
- `tests/policy-triage-check.spec.ts`（16 例，原 13 例保持）：新增 3 例——每行动作类型由 Gate 自己的模块重算且
  与文档一致；文档块与 dump 不符 ⇒ `FAIL action:counts`；有 dump 却缺块 ⇒ `FAIL action:counts`。repo 段缺失时跳过（原 9 例保持）；新增 4 例——行行重算通过、
  文档声称存在而探测不存在 ⇒ `repo:table` 失败、有表无块 ⇒ `repo:counts` 失败、tally 与 dump 不符 ⇒ `repo:tally` 失败。

## 9. 残余风险

1. **`itemIsDue` 仍把 0 当 60 分钟**：停跑行每 60 分钟仍会进 `runRound()`，被 Gate 拒一次（不进 Assessment，
   不花钱），决策日志会有 `schedule-stopped` 噪音。之所以没改 due 过滤：改了这些行就从决策日志里消失了，
   「哪行停跑」反而看不见。要静音就改过滤，但要接受这个代价。
2. **方向表还在改**：11-10 之后已有一条授权字段改动、一条仓库克隆（§5）。本文结论以 rev 4402 为准，
   行内容再变就得重跑 §3 表与 §4 计数。
3. **`intervalMin` 进指纹** = 升级后第一次轮次会给所有行算新 Trigger id（旧 id 不复用），
   `observe` 下表现为「全部行重判一次」。这是有意的：否则恢复巡检的行永远进不来。
4. **仓库路径质量**：68 条里只有 50 条的单元格读成了 `repo-exists-ok`（§5）。其余 18 条现在会被
   Gate 逐条拒（`repo-empty-cell` 8 / `repo-path-ambiguous` 4 / `repo-missing` 3 / 相对路径 1 / 文件 1 / 未克隆 1），
   `pi-agent-cloud` 这种「目录已经不在了」的行从「只能靠人看」变成 `repo-missing`。
   但这仍然是「目录」级别的事实：Obsidian vault 目录、同一个 articleeditor 仓被多行共用，都拦不住。
5. **`schedule-stopped` 只表达停跑，不表达「该跑」**：间隔为正不代表这行值得跑；它只是不再被停跑误放/误拦。
   真正的价值判断仍在 Assessment 与人。
6. **`auto` = 0 是口径的结果**：把 7 条「停跑但恢复后过了仓库层」的行重新开起来，它们才是切 auto 的第一批；
   但要先被 `autonomousRepos` 覆盖、再证明「下一步是仓内可验证改动」。在那之前，`acceptMode` 保持 `observe`。
7. **单进程边界未变**：`ticket-already-open` 的按仓判定与本文无关，多实例互斥仍需部署约束
   （`docs/policy-v3-allowlist.md` §7）。
8. **`repo-exists` 只回答「是不是一个可达目录」**：vault 目录（`recvuwiIQze18J`、`reczz28QOfrbeaIn`、
   `reczz28QkmRdCFEv`）与「不是代码仓的普通目录」都会通过；拦它们只能靠白名单，而不能靠存在性。
9. **相对路径无法判**：`itemToTrigger()` 接受 `baseDir`，但 `Config` 没暴露它，所以 `recvsp1tyH5vPi`
   恒为 `repo-path-relative-unresolved`。要支持“相对方向表目录”得先决定这个基准从哪里来（不能默认进程 cwd）。
10. **存在性进入了指纹**：把仓克隆下来会生成新 Trigger（这是目的）；反过来，移动盘/网络盘断开会让
   该盘上的行各重判一次。代价是一行决策日志，不是放行。
11. **每轮多一次 `statSync`/行**（78 行级）。本地盘可忽略；若仍把方向表指向网络路径，`runOnce()` 的
   耗时会出现一个新的、与模型无关的下限。
