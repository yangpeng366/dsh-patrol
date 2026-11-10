import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('Patrol Config policy defaults', () => {
  it('defaults to policy v3 with a closed repo allowlist and no opt-in', () => {
    const config = Config.parse({})
    expect(config.policyVersion).toBe('v3')
    expect(config.autonomousRepos).toEqual([])
    expect(config.allowAnyRepo).toBe(false)
  })

  it('keeps the opt-in explicit rather than deriving it from a configured allowlist', () => {
    expect(Config.parse({ allowAnyRepo: true }).allowAnyRepo).toBe(true)
    expect(Config.parse({ autonomousRepos: ['D:\\gitAll\\demo'] }).allowAnyRepo).toBe(false)
  })
})
