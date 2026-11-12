import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, createSource } from '../src/index.ts'

describe('Patrol Config policy defaults', () => {
  it('defaults to policy v4 with a closed repo allowlist and no opt-in', () => {
    const config = Config.parse({})
    expect(config.policyVersion).toBe('v4')
    expect(config.autonomousRepos).toEqual([])
    expect(config.allowAnyRepo).toBe(false)
    expect(config.stoppedHeartbeatMs).toBe(12 * 60 * 60 * 1000)
  })

  it('keeps the opt-in explicit rather than deriving it from a configured allowlist', () => {
    expect(Config.parse({ allowAnyRepo: true }).allowAnyRepo).toBe(true)
    expect(Config.parse({ autonomousRepos: ['D:\\gitAll\\demo'] }).allowAnyRepo).toBe(false)
  })

  it('builds a local-json source that the host round can write back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patrol-source-'))
    const file = join(dir, 'items.json')
    await writeFile(file, JSON.stringify([{ id: 'row-1', title: '示例方向', nextStep: '跑一轮', repoPath: 'D:\\gitAll\\demo-a' }]), 'utf8')
    const source = createSource(Config.parse({ kind: 'local-json', tasksFile: file }))
    await source.writeBack('row-1', { currentStage: '已实现', achievement: 'logged tkt_x' })
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[]
    expect(saved[0]!['currentStage']).toBe('已实现')
    expect(saved[0]!['achievement']).toBe('logged tkt_x')
  })
})
