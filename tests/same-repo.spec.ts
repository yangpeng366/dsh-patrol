/**
 * The rehearsal, as a test.
 *
 * It asserts the same thing `node scripts/same-repo-rehearsal.ts` prints, by importing the very
 * same module: there is one copy of the scenarios and one copy of the checks, so a change that
 * makes the script lie also makes this suite fail.
 */
import { describe, expect, it } from 'vitest'
import { runRehearsal, runScenario, SCENARIOS } from '../scripts/same-repo-rehearsal.ts'

describe('same-repo rehearsal (Engine path)', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.title, async () => {
      const result = await runScenario(scenario.name)
      const failed = result.checks.filter((entry) => !entry.ok)
      expect(failed.map((entry) => `${entry.label}: expected ${entry.expected}, actual ${entry.actual}`)).toEqual([])
      expect(result.ok).toBe(true)
    })
  }

  it('proves both rounds were in flight at the same time in the concurrent scenario', async () => {
    const result = await runScenario('same-repo-concurrent')
    expect(result.overlapMs).not.toBeNull()
    expect(result.overlapMs!).toBeGreaterThan(0)
    // Exactly one commit, and every other decision is the Gate refusing a second line.
    expect(result.decisions.filter((decision) => decision.verdict === 'admitted')).toHaveLength(1)
    expect(result.tickets.filter((ticket) => ticket.status !== 'ended')).toHaveLength(1)
  })

  it('runs every scenario in one pass without opening a second ticket anywhere', async () => {
    const results = await runRehearsal()
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.flatMap((result) => result.checks).every((entry) => entry.ok)).toBe(true)
  })
})
