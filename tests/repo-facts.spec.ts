/**
 * `仓库路径` → one structured fact.
 *
 * The cell is free text, so the test suite is a list of cell shapes rather than a list of
 * functions: plain path, forward slashes, relative path, empty, two repos in one cell, a path with
 * a note glued to it, a file instead of a directory, an unreachable drive. The probe is injected
 * for the parsing cases so Windows cells are judged the same on a Linux runner; the last block
 * uses a real temp directory, because "the fact reflects the filesystem" is also part of the claim.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectRepoPath, type RepoProbeResult } from '../src/core/repo-facts.ts'

const DIRECTORY: RepoProbeResult = { kind: 'directory' }
const probe = (result: RepoProbeResult) => () => result

describe('inspectRepoPath: paths that prove a repo', () => {
  it('reports a directory as the one admission shape', () => {
    const fact = inspectRepoPath('D:\\gitAll\\dsh-patrol', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({
      exists: true,
      kind: 'directory',
      normalizedPath: 'D:\\gitAll\\dsh-patrol',
      reason: 'repo-exists-ok',
    })
    expect(fact.candidates).toHaveLength(1)
  })

  it('normalises forward slashes, a trailing separator and a lower-case drive', () => {
    const fact = inspectRepoPath('d:/gitall/dsh-patrol/', { probe: probe(DIRECTORY) })
    expect(fact.normalizedPath).toBe('D:\\gitall\\dsh-patrol')
    expect(fact.reason).toBe('repo-exists-ok')
  })

  it('keeps a UNC path a UNC path', () => {
    const fact = inspectRepoPath('\\\\server\\share\\repo', { probe: probe(DIRECTORY) })
    expect(fact.normalizedPath).toBe('\\\\server\\share\\repo')
    expect(fact.reason).toBe('repo-exists-ok')
  })

  it('reads a POSIX absolute path without a drive', () => {
    const fact = inspectRepoPath('/srv/git/repo', { probe: probe(DIRECTORY) })
    expect(fact.normalizedPath).toBe('/srv/git/repo')
    expect(fact.reason).toBe('repo-exists-ok')
  })

  it('accepts a cell the source delivers as an array of one path', () => {
    const fact = inspectRepoPath(['D:\\gitAll\\dsh-patrol'], { probe: probe(DIRECTORY) })
    expect(fact.reason).toBe('repo-exists-ok')
    expect(fact.normalizedPath).toBe('D:\\gitAll\\dsh-patrol')
  })

  it('does not read the same path written twice as an ambiguity', () => {
    const fact = inspectRepoPath('D:\\gitAll\\dsh-patrol\nD:\\gitAll\\dsh-patrol\\', { probe: probe(DIRECTORY) })
    expect(fact.reason).toBe('repo-exists-ok')
    expect(fact.candidates).toHaveLength(1)
  })
})

describe('inspectRepoPath: cells that denote nothing provable', () => {
  it('names an empty cell instead of treating it as "no repo needed"', () => {
    for (const cell of [null, undefined, '', '   ', '\n\n', []]) {
      expect(inspectRepoPath(cell, { probe: probe(DIRECTORY) })).toMatchObject({
        exists: false,
        kind: 'empty',
        normalizedPath: '',
        reason: 'repo-empty-cell',
      })
    }
  })

  it('refuses two repos in one cell rather than picking the first', () => {
    const fact = inspectRepoPath('E:\\repos\\gitAll\\mpd + E:\\repos\\gitAll\\mpd-front', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({ exists: false, kind: 'multiple', normalizedPath: '', reason: 'repo-path-ambiguous' })
    expect(fact.candidates.map((candidate) => candidate.path)).toEqual([
      'E:\\repos\\gitAll\\mpd',
      'E:\\repos\\gitAll\\mpd-front',
    ])
  })

  it('treats newline-separated paths the same way as a ` + ` cell', () => {
    const fact = inspectRepoPath('D:\\gitAll\\a\nD:\\gitAll\\b', { probe: probe(DIRECTORY) })
    expect(fact.reason).toBe('repo-path-ambiguous')
    expect(fact.candidates).toHaveLength(2)
  })

  it('refuses a path with a note glued to it, but still reports where the path points', () => {
    const fact = inspectRepoPath('D:\\gitAll\\dsh-superagent-prototype（DSH 本体未克隆；上游 https://example.invalid/x）', {
      probe: probe(DIRECTORY),
    })
    expect(fact).toMatchObject({
      exists: true,
      kind: 'directory',
      normalizedPath: 'D:\\gitAll\\dsh-superagent-prototype',
      reason: 'repo-path-ambiguous',
    })
    expect(fact.candidates[0]?.annotation).toContain('未克隆')
  })

  it('reads the table\'s own 未克隆 marker as a refusal, without probing', () => {
    const fact = inspectRepoPath('（未克隆）https://github.com/yangpeng366/ai-theory-app-radar', {
      probe: () => {
        throw new Error('must not probe a URL cell')
      },
    })
    expect(fact).toMatchObject({ exists: false, kind: 'url', normalizedPath: '', reason: 'repo-not-cloned' })
  })

  it('separates a plain URL from a local path', () => {
    expect(inspectRepoPath('https://github.com/x/y', { probe: probe(DIRECTORY) })).toMatchObject({
      exists: false,
      kind: 'url',
      reason: 'repo-not-local-path',
    })
  })

  it('refuses a relative cell when no base directory was given, rather than guessing one', () => {
    const fact = inspectRepoPath('02_部署运维/ccx配置与排查指南.md', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({ exists: false, kind: 'unresolved', normalizedPath: '', reason: 'repo-path-relative-unresolved' })
    expect(fact.candidates[0]?.path).toBe('02_部署运维/ccx配置与排查指南.md')
  })

  it('resolves a relative cell against the base it is given, and probes the resolved path', () => {
    const seen: string[] = []
    const fact = inspectRepoPath('相对/仓库', {
      baseDir: 'D:\\gitAll',
      probe: (path) => { seen.push(path); return DIRECTORY },
    })
    expect(seen).toEqual(['D:\\gitAll\\相对\\仓库'])
    expect(fact.reason).toBe('repo-exists-ok')
    expect(fact.normalizedPath).toBe('D:\\gitAll\\相对\\仓库')
  })
})

describe('inspectRepoPath: paths that exist but are not a repo', () => {
  it('reports a file as existing and still refuses it', () => {
    const fact = inspectRepoPath('D:\\gitAll\\articleeditor-tmp\\README.md', { probe: probe({ kind: 'file' }) })
    expect(fact).toMatchObject({ exists: true, kind: 'file', reason: 'repo-not-a-directory' })
  })

  it('refuses a path that exists as neither file nor directory', () => {
    expect(inspectRepoPath('\\\\.\\pipe\\patrol', { probe: probe({ kind: 'other' }) })).toMatchObject({
      exists: true,
      kind: 'other',
      reason: 'repo-not-a-directory',
    })
  })

  it('reports a missing path as missing, not as ambiguous', () => {
    const fact = inspectRepoPath('D:\\gitAll\\pi-agent-cloud', { probe: probe({ kind: 'missing' }) })
    expect(fact).toMatchObject({ exists: false, kind: 'missing', normalizedPath: 'D:\\gitAll\\pi-agent-cloud', reason: 'repo-missing' })
  })

  it('keeps "cannot look" apart from "not there" (a disconnected drive is not a deleted repo)', () => {
    const fact = inspectRepoPath('E:\\gitAll\\openeyes', { probe: probe({ kind: 'error', code: 'EPERM' }) })
    expect(fact).toMatchObject({ exists: false, kind: 'unreachable', reason: 'repo-path-unreachable' })
  })
})

describe('inspectRepoPath: `标签: 路径` multi-source cells', () => {
  // The table writes a multi-source row with a source name in front of each path. Before this
  // block existed, the colon after the label was read as the start of an annotation, so the
  // candidate became the *label* as a relative path and the whole cell degenerated to `unresolved`
  // even though every path was on disk.
  const OPENEYES = [
    'OpenEyes: E:\\gitAll\\openeyes',
    'agent-desktop (GitCode): C:\\Users\\47037\\source-research\\mouse-cluster\\agent-desktop-gitcode-source',
    'Cua (GitCode): C:\\Users\\47037\\source-research\\mouse-cluster\\cua-gitcode-source',
    'Cua (Gitee): C:\\Users\\47037\\source-research\\mouse-cluster\\cua-gitee-source',
  ].join('; ')

  it('keeps every path of a four-source cell real, with its label, instead of `unresolved` labels', () => {
    const fact = inspectRepoPath(OPENEYES, { probe: probe(DIRECTORY) })
    expect(fact.reason).toBe('repo-path-ambiguous')
    expect(fact.kind).toBe('multiple')
    expect(fact.candidates.map((candidate) => candidate.label)).toEqual([
      'OpenEyes',
      'agent-desktop (GitCode)',
      'Cua (GitCode)',
      'Cua (Gitee)',
    ])
    expect(fact.candidates.map((candidate) => candidate.path)).toEqual([
      'E:\\gitAll\\openeyes',
      'C:\\Users\\47037\\source-research\\mouse-cluster\\agent-desktop-gitcode-source',
      'C:\\Users\\47037\\source-research\\mouse-cluster\\cua-gitcode-source',
      'C:\\Users\\47037\\source-research\\mouse-cluster\\cua-gitee-source',
    ])
    expect(fact.candidates.map((candidate) => candidate.kind)).toEqual(['directory', 'directory', 'directory', 'directory'])
    expect(fact.candidates.every((candidate) => candidate.exists)).toBe(true)
  })

  it('admits one labelled directory: a source name is not a claim about the repo', () => {
    const fact = inspectRepoPath('前端: D:\\gitAll\\mpd', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({
      exists: true,
      kind: 'directory',
      normalizedPath: 'D:\\gitAll\\mpd',
      reason: 'repo-exists-ok',
    })
    expect(fact.candidates[0]?.label).toBe('前端')
    expect(fact.candidates[0]?.annotation).toBeUndefined()
  })

  it('reads a label that carries its own source note, and a POSIX labelled path', () => {
    expect(inspectRepoPath('agent-desktop (GitCode): C:\\src\\agent-desktop', { probe: probe(DIRECTORY) })).toMatchObject({
      reason: 'repo-exists-ok',
      normalizedPath: 'C:\\src\\agent-desktop',
    })
    const posix = inspectRepoPath('render: /srv/git/render', { probe: probe(DIRECTORY) })
    expect(posix.reason).toBe('repo-exists-ok')
    expect(posix.normalizedPath).toBe('/srv/git/render')
    expect(posix.candidates[0]?.label).toBe('render')
  })

  it('still refuses a labelled path with a note glued to it', () => {
    const fact = inspectRepoPath('前端: D:\\gitAll\\mpd（含 mpd-front）', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({ exists: true, kind: 'directory', normalizedPath: 'D:\\gitAll\\mpd', reason: 'repo-path-ambiguous' })
    expect(fact.candidates[0]?.label).toBe('前端')
    expect(fact.candidates[0]?.annotation).toBe('（含 mpd-front）')
  })

  it('does not read a drive letter as a label', () => {
    for (const cell of ['D:\\gitAll\\dsh-patrol', 'D:\\gitAll\\dsh-superagent-prototype（未克隆）']) {
      expect(inspectRepoPath(cell, { probe: probe(DIRECTORY) }).candidates[0]?.label).toBeUndefined()
    }
  })

  it('does not read prose before a colon as a label when no local path follows', () => {
    const fact = inspectRepoPath('说明: 见 docs/xxx.md', { probe: probe(DIRECTORY) })
    expect(fact).toMatchObject({ exists: false, kind: 'unresolved', reason: 'repo-path-relative-unresolved' })
    expect(fact.candidates[0]?.label).toBeUndefined()
  })

  it('keeps a labelled URL or 未克隆 marker a refusal, without probing', () => {
    const noProbe = () => {
      throw new Error('must not probe a cell that names no local path')
    }
    expect(inspectRepoPath('官网: https://github.com/x/y', { probe: noProbe })).toMatchObject({
      kind: 'url',
      reason: 'repo-not-local-path',
    })
    expect(inspectRepoPath('上游: （未克隆）https://github.com/x/y', { probe: noProbe })).toMatchObject({
      kind: 'url',
      reason: 'repo-not-cloned',
    })
  })

  it('reports a labelled missing path as missing, and keeps the label', () => {
    const fact = inspectRepoPath('后端: D:\\gitAll\\pi-agent-cloud', { probe: probe({ kind: 'missing' }) })
    expect(fact).toMatchObject({ exists: false, kind: 'missing', reason: 'repo-missing' })
    expect(fact.candidates[0]?.label).toBe('后端')
  })

  it('does not read the same labelled path twice as two repos', () => {
    const fact = inspectRepoPath('主仓: D:\\gitAll\\sum\n副仓: d:/gitall/sum/', { probe: probe(DIRECTORY) })
    expect(fact.reason).toBe('repo-exists-ok')
    expect(fact.candidates).toHaveLength(1)
    expect(fact.candidates[0]?.label).toBe('主仓')
  })
})

describe('inspectRepoPath: the real filesystem', () => {
  it('proves a temp directory, a file inside it, and a path that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patrol-repo-'))
    const nested = join(dir, 'repo')
    mkdirSync(nested)
    writeFileSync(join(dir, 'notes.md'), '# notes\n', 'utf8')

    expect(inspectRepoPath(nested)).toMatchObject({ exists: true, kind: 'directory', reason: 'repo-exists-ok' })
    expect(inspectRepoPath(join(dir, 'notes.md'))).toMatchObject({ exists: true, kind: 'file', reason: 'repo-not-a-directory' })
    expect(inspectRepoPath(join(dir, 'gone'))).toMatchObject({ exists: false, kind: 'missing', reason: 'repo-missing' })
  })
})
