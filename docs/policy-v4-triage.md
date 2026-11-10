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
| 2 | `read-only` | `授权边界`=只读，或 `当前阶段`=维护且下一步只是复核/观察 | `read-only-direction`；观察类目前无结构化字段（§7） |
| 3 | `approval` | `授权边界`=需审批，或下一步涉及现场部署/发布/密钥/生产配置/用户拍板 | `needs-approval`；其余靠行级字段（§7） |
| 4 | `auto` | `授权边界`=自主，且 `仓库路径` 是真实存在的本地仓，且下一步是仓内可验证的代码/测试/文档改动 | 仓库白名单 + `next-step-present`；缺 `repo-exists` 与动作类型（§7） |

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
| 9 | `recvsHOAmvVKKN` | dsh探索/贡献 | （空） | 维护 | 0 | 自主 | （空） | **excluded** | 停跑且仓库路径为空；恢复后 auto 候选（须先补仓库路径）：下一步是接 dsh dispatcher 并对照官方 discussion。 |
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
按「恢复巡检之后」再看这 56 条：**8 条可达 auto**（判据里写明「恢复后 auto 候选」）、33 条仍属 approval、
13 条为 read-only、2 条要先修字段（`recvriLOrY7RIA` 授权已转只读、`recvsoUROVsJw4` 仓库单元格混写）。

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

顺带记一笔**结构性问题**（不是不一致，是字段质量）：68 条里 8 条 `仓库路径` 为空、1 条带「（未克隆）」标记、
还有 9 条的单元格不是可直接探测的目录 ——

- 路径后接注释（本机其实有该目录，探测却失败）：`recvsoUROVsJw4`、`recvtcJ9QFAFdD`、`recvtcJp44yxWN`
- 两个仓相加：`reczz28QlJEjtOYY`（`E:\repos\gitAll\mpd + E:\repos\gitAll\mpd-front`）
- 指向 md 文件或 vault 目录而非代码仓：`recvsp1tyH5vPi`、`recvtcIOa5kYqH`、`recvuwiIQze18J`、`reczz28QOfrbeaIn`、`reczz28QkmRdCFEv`

这就是 §7 里「仓库路径需要一个纯路径列」的由来：`auto` 的最后一道判据是「真实存在的本地仓」，
而 Gate 目前没有这个事实。

## 6. 代码落点：只加了一条规则，其余是复用

| §2 判定 | 由谁决定 | 状态 |
| --- | --- | --- |
| `excluded`（巡检间隔 0/空） | `schedule-stopped` | **v4 新增** |
| `excluded`（`下一步` 为空） | `no-next-step` | v3 已有 |
| `read-only`（`授权边界`=只读） | `read-only-direction` | v3 已有 |
| `read-only`（维护 + 只复核/观察） | 需要结构化「动作类型」，见 §7 | 未落码 |
| `approval`（`授权边界`=需审批） | `needs-approval` | v3 已有 |
| `approval`（现场/发布/密钥/生产配置/拍板） | 需要结构化「动作类型」，见 §7 | 未落码 |
| `auto` | 仓库白名单 + `next-step-present`；缺 `repo-exists`，见 §7 | 部分 |

具体改动（`src/`）：

1. `DirectionFacts.intervalMin`：新的结构化事实，来自 `巡检间隔(分钟)`，经 `itemFacts()` 写入 Trigger。
   `0` 与空都归一成 `0`（`normalizeItem()` 原本就这么折），Gate 只看「是否为正数」。
2. `DirectionPolicy.gate()` 新增第一道行级拒绝：
   ```
   paused → no-direction-facts → schedule-stopped → 审批状态 → 授权边界 → 下一步 → 仓库层 → ticket 层
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

策略本身没有变聪明：它没有去读 `下一步` 的自然语言。停跑、只读、需审批、无下一步、仓库白名单
都是结构化字段；剩下的三件事（现场/发布/密钥/拍板、仓内可验证改动、实仓存在性）如实写进 §7。

## 7. 需要新增事实（当前 Policy 拿不到，未偷偷降级）

| 缺的事实 | 谁产 | 用在哪 | 不补的后果 |
| --- | --- | --- | --- |
| `repoExists`（存在且是目录，且不是 md/vault） | Source/runner 读表时探测一次，写进 `DirectionFacts` | `auto` 的「真实存在的本地仓」 | 现有替代只有白名单前缀与「（未克隆）」标记；9/68 的单元格连探测都做不了 |
| 动作类型（代码/测试/文档 vs 现场/发布/密钥/配置/拍板） | 方向表新增结构化列，或 Assessment 产出可审计的 `rules` | `read-only` 的后半句、`approval` 的第二种 | 只能人读 `下一步` 判断；Gate 不许做关键词猜测 |
| 纯路径列（与注释分开） | 方向表 | 同上 | 「路径 + 注释」混写让存在性探测误判（3 条样本） |
| 「观察」标记 | 方向表 | `read-only`（维护 + 只复核） | 口径第 2 条后半句无法结构化，只能人判 |
| 巡检间隔「0」与「空」的区分 | 方向表 / `normalizeItem` | 审计可读性 | 两者都拒绝（fail-closed），但日志里分不清「明确停跑」与「忘了填」 |

在这些事实到位之前，`auto` 只能由人工逐行确认 —— 这也正是 v4 之后 `auto` 仍为 0 的直接原因，
不是「没有可自主的工作」，而是「可自主这件事还不能只靠现有字段证明」。

## 8. 验证

```
pnpm typecheck                      clean
pnpm test                           13 files / 96 tests passed
pnpm build                          ok
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110.jsonl --json
                                    total 78, observed 68, ignored 10, wouldAccept 68
node scripts/policy-audit.mjs --file .artifacts/patrol-decisions-20261110-v2.jsonl --json
                                    total 78, observed 16, ignored 62, wouldAccept 16
node scripts/policy-triage-check.mjs --table .artifacts/direction/tbl2XGd8bO10NBY5_20261111_060500_289.ndjson
                                    table:coverage 68/68 · table:verdicts ok · table:structure ok ·
                                    summary:counts ok（含 replay 56/12 与 12/4）· RESULT: PASS
```

新增/调整的断言：

- `tests/policy.spec.ts`：`巡检间隔=0` ⇒ `schedule-stopped`（反例）；缺 `intervalMin` ⇒ `schedule-stopped`（缺事实不放开）；
  同一行改回正数即放行（停跑→恢复）；停跑行即使同时是 `阻塞`/`只读`/无下一步，也只报 `schedule-stopped`（顺序）。
- `tests/mapping.spec.ts`：`facts` 带 `intervalMin`；停跑→恢复指纹不同（否则恢复后仍被判为重复事件）；
  `itemIsDue` 对 0 仍放行（准入归 Gate，见 §9）。
- `tests/runner.spec.ts`、`tests/engine.spec.ts`、`tests/decision-log.spec.ts`、`scripts/same-repo-rehearsal.ts`：
  造行时补上真实间隔，不再依赖「0 = 每轮」。
- `tests/config.spec.ts`：默认 `policyVersion` 变成 `v4`。
- `tests/policy-triage-check.spec.ts`：本文的检查器本身的正反用例（缺行、词表错、结构判定与文档冲突、计数不符）。

## 9. 残余风险

1. **`itemIsDue` 仍把 0 当 60 分钟**：停跑行每 60 分钟仍会进 `runRound()`，被 Gate 拒一次（不进 Assessment，
   不花钱），决策日志会有 `schedule-stopped` 噪音。之所以没改 due 过滤：改了这些行就从决策日志里消失了，
   「哪行停跑」反而看不见。要静音就改过滤，但要接受这个代价。
2. **方向表还在改**：11-10 之后已有一条授权字段改动、一条仓库克隆（§5）。本文结论以 rev 4402 为准，
   行内容再变就得重跑 §3 表与 §4 计数。
3. **`intervalMin` 进指纹** = 升级后第一次轮次会给所有行算新 Trigger id（旧 id 不复用），
   `observe` 下表现为「全部行重判一次」。这是有意的：否则恢复巡检的行永远进不来。
4. **仓库路径质量**：18/68 的单元格不是可直接探测的目录（§5）。在 `repo-exists` 落地前，
   auto 的「实仓」判据只能靠白名单前缀 + 人工复核，`pi-agent-cloud` 这种「目录已经不在了」的行也拦不住。
5. **`schedule-stopped` 只表达停跑，不表达「该跑」**：间隔为正不代表这行值得跑；它只是不再被停跑误放/误拦。
   真正的价值判断仍在 Assessment 与人。
6. **`auto` = 0 是口径的结果**：若把 8 条「停跑但恢复后可达 auto」的行重新开起来，它们才是切 auto 的第一批；
   在那之前，`acceptMode` 保持 `observe`。
7. **单进程边界未变**：`ticket-already-open` 的按仓判定与本文无关，多实例互斥仍需部署约束
   （`docs/policy-v3-allowlist.md` §7）。
