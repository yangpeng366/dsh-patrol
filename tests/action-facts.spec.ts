import { describe, expect, it } from 'vitest'
import { MAX_EVIDENCE, actionRefusal, evidenceAt, inspectAction, isRepoWork } from '../src/core/action-facts.ts'

/**
 * Real `下一步` lines from the 2026-11-11 direction table (rev 4402), desensitised: internal host
 * names, record ids and account names are replaced, the sentence shape is kept. Each sample is the
 * evidence the classifier was tuned against, not a sentence invented to fit the word list.
 */
const ROWS = {
  code: {
    // recvuIj52aeBBU · articleeditor 推送前正文表达式支持
    nextStep: '完成 editor 全量编译；补处理器单测；测试环境验证正文处理及 SNS 不重复执行；检查日志脱敏',
  },
  test: {
    // recvuwiIQze18J · OpenEyes Record
    nextStep: '补 test_mcp_record_replay.py 的两条 call_tool 用例（现 skip），确认工具注册与分发；再评估 GBK 控制台输出',
  },
  doc: {
    // recvw7SVIEOwBh · 个人稿库提交追回逻辑
    nextStep: '本轮标收尾/退役，不再排巡检推进。详见 docs/debug/r44-r46-45-smoke-20261009.md',
  },
  field: {
    // reczz28P786xqawA · 群组稿库审核与自动签发
    nextStep: '现场把平台升级到含 f995ff451 的包后复测：提交 2 → 群组稿库点编辑 → 编辑页点保存',
  },
  release: {
    // reczz28QTKcOv7Tq · MPD 移动端发布生效巡检
    nextStep: '执行 60 发布（可运行可执行）：node build-deploy_60.js --target mpd，再跑 release-verify 复核',
  },
  config: {
    // recvu7x80TvxiM · 多媒体-发布
    nextStep: '45 端 ConfigMap 与双账号拆分已就绪，Jenkins 滚动验证通过；待用户补一条可自检断言',
  },
  decision: {
    // recvvPSdSO6yTa · OpenEyes / third-hand 借鉴调研
    nextStep: '列待用户决策 4 项：①PR-1/2 立项与 ping 时机 ②PR-3 解封条件确认 ③跨仓同步三档 ④本档 L2 搬迁',
  },
  secret: {
    // recvv0TxKLm7gh · patrol-scaffold 开源脚手架
    nextStep: '有凭据时把 bitable / tencent-docs 从 SKIP 变实跑，记录各自最小权限与失败面',
  },
} as const

describe('inspectAction · one real row per kind', () => {
  it('reads a compile + unit-test line as repo-code, not as repo-test', () => {
    const fact = inspectAction(ROWS.code)
    expect(fact.kind).toBe('repo-code')
    expect(fact.matched).toContain('编译')
    expect(fact.field).toBe('下一步')
    expect(fact.evidence).toContain('编译')
    expect(fact.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE)
    expect(isRepoWork(fact.kind)).toBe(true)
    expect(actionRefusal(fact.kind)).toBeUndefined()
  })

  it('reads a call_tool 用例 line as repo-test', () => {
    const fact = inspectAction(ROWS.test)
    expect(fact.kind).toBe('repo-test')
    expect(fact.matched).toContain('用例')
    expect(actionRefusal(fact.kind)).toBeUndefined()
  })

  it('reads a docs-only line as repo-doc', () => {
    const fact = inspectAction(ROWS.doc)
    expect(fact.kind).toBe('repo-doc')
    expect(fact.matched).toContain('docs')
    expect(actionRefusal(fact.kind)).toBeUndefined()
  })

  it('reads a 现场 line as field-ops with its own refusal', () => {
    const fact = inspectAction(ROWS.field)
    expect(fact.kind).toBe('field-ops')
    expect(fact.matched).toContain('现场')
    expect(actionRefusal(fact.kind)).toBe('action-field-ops')
  })

  it('reads a 发布 line as release, even though it also says 复核', () => {
    const fact = inspectAction(ROWS.release)
    expect(fact.kind).toBe('release')
    expect(fact.matched).toEqual(expect.arrayContaining(['发布', 'release']))
    expect(actionRefusal(fact.kind)).toBe('action-release')
  })

  it('reads a ConfigMap line as config', () => {
    const fact = inspectAction(ROWS.config)
    expect(fact.kind).toBe('config')
    expect(fact.matched).toContain('ConfigMap')
    expect(actionRefusal(fact.kind)).toBe('action-needs-config')
  })

  it('reads a 待用户决策 line as decision', () => {
    const fact = inspectAction(ROWS.decision)
    expect(fact.kind).toBe('decision')
    expect(fact.matched).toContain('待用户')
    expect(actionRefusal(fact.kind)).toBe('action-needs-decision')
  })

  it('reads a 凭据 line as secret', () => {
    const fact = inspectAction(ROWS.secret)
    expect(fact.kind).toBe('secret')
    expect(fact.matched).toContain('凭据')
    expect(actionRefusal(fact.kind)).toBe('action-needs-secret')
  })
})

describe('inspectAction · reverse samples: 代码 in the sentence, not code work', () => {
  it('does not call a 拍板 sentence repo-code', () => {
    const fact = inspectAction({ nextStep: '代码与单测均已就位，等用户拍板后再动' })
    expect(fact.kind).toBe('decision')
    expect(fact.matched).toContain('拍板')
    expect(fact.alternatives.map((entry) => entry.kind)).toContain('repo-code')
  })

  it('does not call a 发版 sentence repo-code', () => {
    const fact = inspectAction({ nextStep: '代码已改完，下一个构建发版到 60，再复验脏标签率' })
    expect(fact.kind).toBe('release')
    expect(actionRefusal(fact.kind)).toBe('action-release')
  })

  it('does not call a 密钥 sentence repo-code', () => {
    const fact = inspectAction({ nextStep: '补齐 caoyuan 配置并拿到 SecretId/Key 后再实现标签链路' })
    expect(fact.kind).toBe('secret')
    expect(actionRefusal(fact.kind)).toBe('action-needs-secret')
  })

  it('does not call a 现场 sentence repo-code', () => {
    const fact = inspectAction({ nextStep: '现场换上镜像后按 5 步验证登录页，代码不再改' })
    expect(fact.kind).toBe('field-ops')
  })

  it('does not call a Bitable/表字段 sentence repo-code', () => {
    const fact = inspectAction({ nextStep: '先在 Bitable 加一个新字段并回填，再改代码读取' })
    expect(fact.kind).toBe('config')
    expect(actionRefusal(fact.kind)).toBe('action-needs-config')
  })
})

describe('inspectAction · fail-closed', () => {
  it('returns unclear, never repo-code, when the line only reports observation', () => {
    const fact = inspectAction({ nextStep: '复核完成：14/14 跟踪文件长度与 SHA-256 一致，无漂移' })
    expect(fact.kind).toBe('unclear')
    expect(fact.matched).toHaveLength(0)
    expect(fact.evidence).toBe('')
    expect(fact.field).toBe('')
    expect(fact.reason).toContain('未命中任何动作词')
    expect(actionRefusal(fact.kind)).toBe('action-unclear')
  })

  it('returns unclear for English boilerplate that names no action', () => {
    const fact = inspectAction({ nextStep: 'Review the saved Codex output before retrying this project round' })
    expect(fact.kind).toBe('unclear')
    expect(fact.reason).toContain('未命中')
  })

  it('returns unclear for an empty next step and says the cell is empty', () => {
    const fact = inspectAction({ nextStep: '   ', description: '多媒体的一个方向' })
    expect(fact.kind).toBe('unclear')
    expect(fact.reason).toContain('为空')
  })

  it('does not admit a row whose 代码 only appears in 用户批注, and keeps it as context', () => {
    const fact = inspectAction({
      nextStep: '盯 #9004 的维护者评论与新 CI；#8984 看评审建议是否被采纳',
      userNote: '2026-08-28 决策：外部贡献仓，提交代码前先看七鉴',
    })
    expect(fact.kind).toBe('unclear')
    expect(fact.alternatives).toEqual([])
    expect(fact.reason).toContain('未命中')
  })

  it('does not let 简要描述 admit repo work: it is context, not an action', () => {
    const fact = inspectAction({
      nextStep: '屏幕可见性需人工安装并启用虚拟显示适配器后再验第二桌面捕获',
      description: '放权 + 高频推进：本地 worktree/分支可 commit/lint/test；推送到 PR 等可以自主决策',
    })
    expect(fact.kind).toBe('unclear')
    expect(fact.alternatives.map((entry) => entry.kind)).toContain('repo-code')
    expect(fact.reason).toContain('不足以准入')
  })

  it('reads 授权边界=需审批 as a pending decision without reading 下一步 for keywords', () => {
    const fact = inspectAction({ nextStep: '梳理 skill 契约与能力清单', authorization: '需审批' })
    expect(fact.kind).toBe('decision')
    expect(fact.field).toBe('授权边界')
  })

  it('reads 审批状态=待审 as a pending decision', () => {
    const fact = inspectAction({ nextStep: '梳理 skill 契约与能力清单', approval: '待审' })
    expect(fact.kind).toBe('decision')
    expect(fact.field).toBe('审批状态')
  })

  it('ignores a negated credential mention instead of calling it a secret', () => {
    const fact = inspectAction({ nextStep: '把 docs 补齐，仓库保持零凭据，密码不入文档' })
    expect(fact.kind).toBe('repo-doc')
    expect(fact.matched).not.toContain('凭据')
  })

  it('does not read a JS "Unexpected token" message as a secret', () => {
    const fact = inspectAction({ nextStep: '修掉页面刷新时 "Unexpected token \'<\'" 的报错，并补一条回归用例' })
    expect(fact.kind).toBe('repo-test')
    expect(fact.matched).not.toContain('token')
  })
})

describe('inspectAction · the structured 动作类型 column', () => {
  // The column is the fact: a value someone wrote down is not re-read from prose. `发版` in `下一步`
  // would be `release` by the word list, and the row is still repo-test because the table says so.
  it('takes the column value even when 下一步 reads like a release', () => {
    const fact = inspectAction({ actionType: 'repo-test', nextStep: '构建并发版到 60，再复验脏标签率' })
    expect(fact.kind).toBe('repo-test')
    expect(fact.source).toBe('column')
    expect(fact.field).toBe('动作类型')
    expect(fact.evidence).toBe('repo-test')
    expect(fact.reason).toContain('结构化列')
    expect(fact.reason).toContain('词表判为 release')
    // The disagreement stays auditable instead of disappearing.
    expect(fact.alternatives.map((entry) => entry.kind)).toContain('release')
    expect(actionRefusal(fact.kind)).toBeUndefined()
  })

  it('tolerates case and surrounding whitespace in the cell', () => {
    const fact = inspectAction({ actionType: '  Repo-Code\u00a0', nextStep: '补一个单测' })
    expect(fact.kind).toBe('repo-code')
    expect(fact.source).toBe('column')
  })

  it('reads a column-sourced non-repo kind as that refusal, not as repo work', () => {
    const fact = inspectAction({ actionType: 'secret', nextStep: '编译并提交代码' })
    expect(fact.kind).toBe('secret')
    expect(fact.source).toBe('column')
    expect(actionRefusal(fact.kind)).toBe('action-needs-secret')
  })

  it('falls back to the word list when the cell is blank, and says so', () => {
    const fact = inspectAction({ actionType: '   ', nextStep: '补一个单测' })
    expect(fact.kind).toBe('repo-test')
    expect(fact.source).toBe('text')
    expect(fact.reason).toContain('列值为空')
    expect(fact.reason).toContain('已退回词表推断')
  })

  it('treats a missing column exactly like a blank one, without touching the pre-column reason', () => {
    const absent = inspectAction({ nextStep: '补一个单测' })
    expect(absent.source).toBe('text')
    expect(absent.kind).toBe('repo-test')
    // No column at all: the reason is the pre-column sentence, byte for byte.
    expect(absent.reason).toBe(inspectAction({ nextStep: '补一个单测', actionType: undefined }).reason)
    expect(absent.reason).not.toContain('退回词表')
  })

  // Fail-closed: an unreadable cell is not "no answer". Falling back to prose could turn the typo
  // into repo-code, which is the one silent pass this module exists to prevent.
  it('refuses an unreadable column value as unclear instead of guessing repo work', () => {
    for (const value of ['auto', 'Repo Code', '待定', 'repo_code', 'repo-code!']) {
      const fact = inspectAction({ actionType: value, nextStep: '编译并提交代码' })
      expect(fact.kind).toBe('unclear')
      expect(fact.source).toBe('column')
      expect(fact.reason).toContain('不在允许集合内')
      expect(actionRefusal(fact.kind)).toBe('action-unclear')
      // What the row would have been read as is still visible, but it is not the verdict.
      expect(fact.alternatives.map((entry) => entry.kind)).toContain('repo-code')
    }
  })

  it('honours a written-down unclear without falling back to the word list', () => {
    const fact = inspectAction({ actionType: 'unclear', nextStep: '编译并提交代码' })
    expect(fact.kind).toBe('unclear')
    expect(fact.source).toBe('column')
    expect(fact.field).toBe('动作类型')
    expect(fact.alternatives.map((entry) => entry.kind)).toContain('repo-code')
  })

  it('keeps evidence at most 80 characters for a long column value', () => {
    const fact = inspectAction({ actionType: `${'x'.repeat(200)}` })
    expect(fact.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE)
    expect(fact.kind).toBe('unclear')
  })
})

describe('inspectAction · evidence and tie-breaks', () => {
  it('keeps the evidence under 80 characters and points at the window around the match', () => {
    const long = `${'前置说明文字。'.repeat(20)}现场执行升级脚本${'后续说明文字。'.repeat(20)}`
    const fact = inspectAction({ nextStep: long })
    expect(fact.kind).toBe('field-ops')
    expect(fact.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE)
    expect(fact.evidence).toContain('现场')
    expect(fact.evidence.startsWith('…')).toBe(true)
    expect(fact.evidence.endsWith('…')).toBe(true)
  })

  it('never returns more than 80 characters from evidenceAt, whatever the window', () => {
    const text = 'x'.repeat(400)
    expect(evidenceAt(text, 200, 2).length).toBeLessThanOrEqual(MAX_EVIDENCE)
    expect(evidenceAt('short', 0, 1)).toBe('short')
  })

  it('uses 贡献类型 only to choose between repo kinds that already matched', () => {
    const line = '完成编译并补单测'
    expect(inspectAction({ nextStep: line }).kind).toBe('repo-code')
    expect(inspectAction({ nextStep: line, contribution: '测试补充' }).kind).toBe('repo-test')
    expect(inspectAction({ nextStep: line, contribution: '功能增强' }).kind).toBe('repo-code')
  })

  it('does not let 贡献类型 create repo work on its own', () => {
    const fact = inspectAction({ nextStep: '维持现状，等新信号', contribution: '功能增强' })
    expect(fact.kind).toBe('unclear')
  })

  it('prefers the most restrictive kind and records the others as alternatives', () => {
    const fact = inspectAction({ nextStep: '现场补密钥后实现登录链路' })
    expect(fact.kind).toBe('secret')
    expect(fact.alternatives.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['field-ops', 'repo-code']))
    expect(fact.reason).toContain('同时命中')
  })

  it('respects ASCII word boundaries: test in latest is not a test', () => {
    expect(inspectAction({ nextStep: '刷新 latest 页面看有没有新条目' }).kind).toBe('unclear')
  })
})
