/**
 * The scope audit: does a row's `仓库路径` contain the directory its `下一步` names?
 *
 * Two halves, pinned separately because they fail differently:
 *
 *   - the *reading* (`pathsIn()`), which must not turn a URL or a `file:line` reference into a path,
 *     and must not treat a path that is not on disk as evidence of drift — prose noise is not a fact;
 *   - the *verdict* (`readScope()`), which is only `drift` when a directory that exists lies outside
 *     every root. `aligned`, `no-root` and `silent` are different answers and the report keeps them
 *     apart, because `silent` is the majority: a row can be dispatched out of scope without ever
 *     writing a path down.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditRecords, contains, parseArgs, pathsIn, readScope, renderReport, tally } from '../scripts/scope-audit.ts'

describe('pathsIn', () => {
  it('reads an absolute path out of prose and trims the sentence marks after it', () => {
    expect(pathsIn('在 D:\\gitAll\\mpd 里改一处')).toEqual(['D:\\gitAll\\mpd'])
    expect(pathsIn('结论见 D:\\gitAll\\mpd\\docs\\a.md:1。下一步再说')).toEqual(['D:\\gitAll\\mpd\\docs\\a.md'])
    expect(pathsIn('E:/gitAll/x。')).toEqual(['E:/gitAll/x'])
  })

  it('does not turn a URL into a drive path', () => {
    expect(pathsIn('https://moc.example.com/articleeditor/index.html#/editor')).toEqual([])
    expect(pathsIn('ssh://git@ssh.github.com:443/org/repo.git')).toEqual([])
  })

  it('keeps one copy of a path written twice', () => {
    expect(pathsIn('D:\\gitAll\\mpd 与 D:\\gitAll\\mpd 是同一个仓')).toEqual(['D:\\gitAll\\mpd'])
  })
})

describe('contains', () => {
  it('accepts the root itself and anything below it', () => {
    expect(contains('D:\\gitAll\\mpd', 'D:\\gitAll\\mpd')).toBe(true)
    expect(contains('D:\\gitAll\\mpd', 'D:\\gitAll\\mpd\\src\\a.ts')).toBe(true)
    expect(contains('D:\\gitAll\\mpd', 'd:\\gitall\\mpd\\src')).toBe(true)
  })

  it('rejects a sibling that only shares a prefix', () => {
    expect(contains('D:\\gitAll\\mpd', 'D:\\gitAll\\mpd-front')).toBe(false)
    expect(contains('D:\\gitAll\\mpd', 'D:\\gitAll')).toBe(false)
  })
})

describe('readScope', () => {
  let root: string
  let repo: string
  let other: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scope-audit-'))
    repo = join(root, 'repo')
    other = join(root, 'other')
    mkdirSync(repo)
    mkdirSync(other)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is aligned when the named directory sits inside the row repo', () => {
    mkdirSync(join(repo, 'src'))
    const reading = readScope(`在 ${join(repo, 'src')} 里补一条用例`, repo)
    expect(reading.verdict).toBe('aligned')
    expect(reading.roots).toEqual([repo])
    expect(reading.outside).toEqual([])
  })

  it('is drift when the named directory exists outside the row repo', () => {
    writeFileSync(join(other, 'run.ps1'), 'exit 0', 'utf8')
    const reading = readScope(`改 ${join(other, 'run.ps1')}`, repo)
    expect(reading.verdict).toBe('drift')
    // A file token is read as its parent directory: that is where the work lands.
    expect(reading.named[0]?.kind).toBe('parent-of-file')
    expect(reading.outside).toEqual([other])
  })

  it('does not count a file that is not there yet — only what exists proves scope', () => {
    const reading = readScope(`新建 ${join(other, 'later.ps1')}`, repo)
    expect(reading.verdict).toBe('silent')
    expect(reading.unreadable).toEqual([join(other, 'later.ps1')])
  })

  it('is silent when the row names no directory at all', () => {
    const reading = readScope('继续补自检，抽成纯函数', repo)
    expect(reading.verdict).toBe('silent')
    expect(reading.roots).toEqual([repo])
  })

  it('never counts a path that is not on disk', () => {
    const missing = join(root, 'nope', 'gone.md')
    const reading = readScope(`见 ${missing} 的第 3 节`, repo)
    expect(reading.verdict).toBe('silent')
    expect(reading.unreadable).toEqual([missing])
  })

  it('is no-root when a directory is named but the cell holds no repo', () => {
    const reading = readScope(`改 ${other} 里的脚本`, '')
    expect(reading.verdict).toBe('no-root')
    expect(reading.roots).toEqual([])
    expect(reading.rootReason).toBe('repo-empty-cell')
    expect(reading.outside).toEqual([other])
  })

  it('reads an annotated cell for what it resolves to, not for how it is written', () => {
    const reading = readScope('看看别的目录', `${repo}（本地检出）`)
    // The Gate calls the cell ambiguous (it hands no single path to a Ticket), but the audit still
    // reads the directory the cell names: that is the candidate work would land in.
    expect(reading.rootReason).toBe('repo-path-ambiguous')
    expect(reading.roots).toEqual([repo])
    expect(reading.verdict).toBe('silent')
  })

  it('counts a file at the root itself as drift only when it is elsewhere', () => {
    const file = join(repo, 'notes.md')
    writeFileSync(file, 'x', 'utf8')
    expect(readScope(`更新 ${file}`, repo).verdict).toBe('aligned')
  })
})

describe('report', () => {
  it('keeps the four verdicts apart and names both sides of a drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-report-'))
    try {
      const repo = join(root, 'repo')
      const other = join(root, 'other')
      mkdirSync(repo)
      mkdirSync(other)
      writeFileSync(join(repo, 'x'), 'x', 'utf8')
      writeFileSync(join(other, 'y'), 'y', 'utf8')
      const records = [
        { id: 'a', title: 'aligned', nextStep: `改 ${join(repo, 'x')}`, intervalMin: 60, repoPath: repo },
        { id: 'b', title: 'drift', nextStep: `改 ${join(other, 'y')}`, intervalMin: 60, repoPath: repo },
        { id: 'c', title: 'silent', nextStep: '继续观察', intervalMin: 60, repoPath: repo },
        { id: 'd', title: 'no-root', nextStep: `改 ${other}`, intervalMin: 0, repoPath: '' },
      ]
      const readings = auditRecords(records)
      expect(tally(readings)).toEqual({ aligned: 1, drift: 1, 'no-root': 1, silent: 1 })
      const report = renderReport('fixture.ndjson', readings, new Set(['a', 'b', 'c']))
      expect(report).toContain('rows 4 · aligned 1 · drift 1 · no-root 1 · silent 1')
      expect(report).toContain('due  3 · aligned 1 · drift 1 · no-root 0 · silent 1')
      expect(report).toContain('b [due] drift')
      expect(report).toContain(`下一步 names ${other} — outside every root`)
      expect(report).toContain('silent = 下一步 names no directory on disk')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('parses only the flags it documents', () => {
    expect(parseArgs(['--dump', 'x.ndjson', '--due', '--json'])).toEqual({ dump: 'x.ndjson', due: true, json: true, help: false })
    expect(() => parseArgs(['--dump'])).toThrow(/--dump/)
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/)
  })
})
