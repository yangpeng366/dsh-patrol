#!/usr/bin/env node
/**
 * release-check — one command that answers "may this tarball ship?"
 *
 * The README documents what a tarball is supposed to contain (§5) and what a clone is supposed to
 * pass (Verification). Both are claims until something machine-checkable runs them. This script is
 * that something, and it runs the release path a consumer actually takes:
 *
 *   1. `pnpm typecheck` / `pnpm test` / `pnpm build` — the source is green before anything is packaged;
 *   1b. `src/core/action-vocabulary.ts` passes its own `verifyActionVocabulary()` — the nine action
 *      kinds are a closed set, every spelling reads back as itself, and the per-kind tally adds up.
 *      This runs from source even with `--skip-steps`, because it is cheap and it is the invariant
 *      the rest of the action layer assumes;
 *   2. `pnpm pack` into the system temp directory — nothing is left in the repo;
 *   3. the tarball holds every file the plugin loads at runtime (patch, lib, skill, docs);
 *   4. the tarball holds none of the clone-only material (src, tests, scripts, schemas, residues);
 *   5. the CLI starts from the unpacked tarball alone, with no repo `node_modules` on the path —
 *      proved by running it, and by checking that `lib/cli.js` reaches nothing but `node:` builtins
 *      and its own relative chunks;
 *   6. `package.json.version` is the newest `## [x.y.z]` entry in CHANGELOG.md;
 *   7. the tarball's SHA256, byte count and file count are printed, then `RESULT: PASS` plus one
 *      line of JSON.
 *
 *   node scripts/release-check.mjs
 *   node scripts/release-check.mjs --keep-temp      # keep the temp dir (pack + unpack) for triage
 *   node scripts/release-check.mjs --skip-steps     # diagnostic only: pack side without pnpm check
 *
 * Exit codes: 0 pass, 1 a check failed, 2 usage error. It never publishes, tags, commits or pushes:
 * `pnpm pack` writes a tarball and nothing else, and that tarball lives in the temp directory.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The action vocabulary, loaded from source so its invariants run on every candidate tarball.
 *
 * Node >= 22.19 strips the TypeScript the same way `pnpm test` does, and a failure to load is a
 * failed check (never a crash): a release candidate that cannot read its own vocabulary must not
 * pass. `--skip-steps` does not skip this — it is the one gate that still runs when pnpm is absent.
 */
const vocabulary = await import(new URL('../src/core/action-vocabulary.ts', import.meta.url).href)
  .catch((error) => ({ loadError: error instanceof Error ? error.message : String(error) }))

/** Everything the loaded plugin, the host patch and the packaged skill need at runtime. */
const REQUIRED_ENTRIES = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/index.d.ts',
  'package/lib/cli.js',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/skills/dsh-patrol/SKILL.md',
]

/** Clone-only directories: README §5 says these stay in the source repo. */
const FORBIDDEN_PREFIXES = ['package/src/', 'package/tests/', 'package/scripts/', 'package/schemas/']

/** Archives, logs and editor droppings must never ship. */
const RESIDUE_RE = /\.(tgz|tar|gz|zip|log|tmp|temp|orig|rej|bak|swp)$/i
const OS_RESIDUE_RE = /(^|\/)(\.DS_Store|Thumbs\.db|\.git|node_modules)(\/|$)/i

const STEPS = ['typecheck', 'test', 'build']

const USAGE = `usage: node scripts/release-check.mjs [--skip-steps] [--keep-temp]

  --skip-steps  skip pnpm typecheck / test / build (diagnostic: checks only the artifact).
  --keep-temp   keep the temp directory holding the tarball and the unpacked package.
  --help, -h    show this message.

Exit codes: 0 pass, 1 a check failed, 2 usage error.`

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function quoteArg(value) {
  const text = String(value)
  return /\s/.test(text) ? `"${text}"` : text
}

/**
 * Runs a command through the platform shell.
 *
 * `shell: true` is what makes `pnpm` resolvable on Windows, where it is a `.cmd` shim Node cannot
 * spawn by bare name; the argument is quoted by hand because Node does not quote in shell mode.
 */
function run(command, options = {}) {
  return spawnSync(command, { shell: true, cwd: REPO_ROOT, encoding: 'utf8', ...options })
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n)
}

function human(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Every file under `dir`, skipping the two trees that make a walk expensive. */
function listTarballs(dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) found.push(full)
    }
  }
  walk(dir)
  return found.sort()
}

function tarEntries(tarball) {
  const result = run(`tar -tzf ${quoteArg(tarball)}`)
  if (result.error) throw new Error(`tar could not run: ${result.error.message}（Windows 10+ 自带 bsdtar；Linux/macOS 由系统提供）`)
  if (result.status !== 0) throw new Error(`tar -tzf failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The `## [x.y.z]` headings of CHANGELOG.md, newest first, in file order. */
function changelogVersions(text) {
  const versions = []
  const re = /^##\s*\[\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*\]/gm
  let match
  while ((match = re.exec(text)) !== null) versions.push(match[1])
  return versions
}

/**
 * Module specifiers `lib/cli.js` imports, so "the CLI starts on its own" is checked as a property
 * and not only as one lucky `--help` run.
 *
 * The tarball ships no `node_modules`; a bare specifier (`zod`, `@deepseek-ai/…`) would make the CLI
 * die at import time on a machine that has not installed the package's dependencies.
 */
function cliImportSpecifiers(cliSource) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;])import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(cliSource)) !== null) specifiers.add(match[1])
  }
  return [...specifiers].sort()
}

function parseArgs(argv) {
  const options = { skipSteps: false, keepTemp: false, help: false }
  for (const arg of argv) {
    if (arg === '--skip-steps') options.skipSteps = true
    else if (arg === '--keep-temp') options.keepTemp = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown option ${arg}`)
  }
  return options
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`release-check: ${messageOf(error)}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const failures = []
  const fail = (check, detail) => {
    failures.push({ check, detail })
    process.stdout.write(`  FAIL ${check}: ${detail}\n`)
  }
  const ok = (check, detail) => process.stdout.write(`  ok   ${check}${detail ? `: ${detail}` : ''}\n`)

  const summary = {
    check: 'dsh-patrol release',
    ok: false,
    repo: REPO_ROOT,
    version: null,
    changelogVersion: null,
    steps: [],
    tarball: { file: null, bytes: null, sha256: null, files: null },
    content: { required: { expected: REQUIRED_ENTRIES.length, missing: [] }, forbidden: [] },
    vocabulary: { kinds: null, problems: [] },
    cli: { command: null, exitCode: null, selfContained: false, specifiers: [] },
    tempDir: null,
    failures,
  }

  // A missing package.json means this is not the repo; nothing else can be judged.
  let repoPkg
  try {
    repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  } catch (error) {
    process.stderr.write(`release-check: cannot read package.json in ${REPO_ROOT}: ${messageOf(error)}\n`)
    return 1
  }
  summary.version = typeof repoPkg.version === 'string' ? repoPkg.version : null
  process.stdout.write(`release-check ${repoPkg.name}@${summary.version ?? '(no version)'}\n`)

  const tarballsBefore = new Set(listTarballs(REPO_ROOT))
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-patrol-release-'))
  summary.tempDir = tempDir
  let tarball = null

  try {
    // 1 — the source is green before it is packaged.
    if (!options.skipSteps) {
      process.stdout.write('\n[1/5] source gates: pnpm typecheck / test / build\n')
      for (const step of STEPS) {
        process.stdout.write(`$ pnpm ${step}\n`)
        const started = nowMs()
        const result = run(`pnpm ${step}`, { stdio: 'inherit' })
        const elapsed = nowMs() - started
        const exitCode = result.status
        summary.steps.push({ name: `pnpm ${step}`, exitCode, ms: elapsed })
        if (exitCode !== 0) {
          fail(`step:${step}`, `pnpm ${step} exited ${exitCode ?? '(no status)'} after ${human(elapsed)}`)
          break
        }
        process.stdout.write(`  ok   pnpm ${step} (${human(elapsed)})\n`)
      }
      if (failures.length > 0) return finish(summary, failures, tempDir, options)
    } else {
      process.stdout.write('\n[1/5] source gates: skipped (--skip-steps)\n')
    }

    // 1b — the action vocabulary's own invariants, from source. This is the check that keeps the
    // nine spellings a closed set: a tenth kind, a duplicate, a spelling that no longer reads back
    // as itself, or a tally that does not add up fails here whether or not vitest ran.
    process.stdout.write('\n[1b/5] action vocabulary: src/core/action-vocabulary.ts\n')
    if ('loadError' in vocabulary) {
      fail('vocabulary:invariants', `cannot load src/core/action-vocabulary.ts: ${vocabulary.loadError}`)
    } else {
      const problems = vocabulary.verifyActionVocabulary()
      summary.vocabulary = { kinds: vocabulary.ACTION_KINDS.length, problems }
      if (problems.length > 0) fail('vocabulary:invariants', problems.join(' · '))
      else ok('vocabulary:invariants', `${summary.vocabulary.kinds} kinds · read / count / write agree`)
    }

    // 2 — pack into the temp directory, so the repo gains no build output.
    process.stdout.write('\n[2/5] pnpm pack into a temp directory\n')
    const packed = run(`pnpm pack --pack-destination ${quoteArg(tempDir)}`)
    if (packed.status !== 0) {
      fail('pack', `pnpm pack exited ${packed.status ?? '(no status)'}: ${(packed.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ')}`)
      return finish(summary, failures, tempDir, options)
    }
    const produced = readdirSync(tempDir).filter((name) => name.toLowerCase().endsWith('.tgz'))
    if (produced.length !== 1) {
      fail('pack', `expected exactly one .tgz in ${tempDir}, found ${produced.length}${produced.length > 0 ? ` (${produced.join(', ')})` : ''}`)
      return finish(summary, failures, tempDir, options)
    }
    tarball = join(tempDir, produced[0])
    summary.tarball.file = produced[0]
    summary.tarball.bytes = statSync(tarball).size
    summary.tarball.sha256 = sha256(tarball)
    ok('pack', `${produced[0]} ${summary.tarball.bytes} bytes`)

    const leaked = listTarballs(REPO_ROOT).filter((file) => !tarballsBefore.has(file))
    if (leaked.length > 0) fail('pack:repo-clean', `tarball left inside the repo: ${leaked.map((f) => f.slice(REPO_ROOT.length + 1)).join(', ')}`)
    else ok('pack:repo-clean', 'no tarball in the repo')

    // 3 — the tarball holds everything the host and the skill read.
    process.stdout.write('\n[3/5] tarball contents\n')
    let entries
    try {
      entries = tarEntries(tarball)
    } catch (error) {
      fail('tar', messageOf(error))
      return finish(summary, failures, tempDir, options)
    }
    const files = entries.filter((entry) => !entry.endsWith('/'))
    summary.tarball.files = files.length
    const fileSet = new Set(files)

    const missing = REQUIRED_ENTRIES.filter((entry) => !fileSet.has(entry))
    summary.content.required.missing = missing
    if (missing.length > 0) fail('content:required', `missing ${missing.length}/${REQUIRED_ENTRIES.length}: ${missing.join(', ')}`)
    else ok('content:required', `${REQUIRED_ENTRIES.length}/${REQUIRED_ENTRIES.length} present`)

    // 4 — and nothing that only makes sense in a clone.
    const forbiddenHits = []
    for (const entry of files) {
      const prefix = FORBIDDEN_PREFIXES.find((candidate) => entry.startsWith(candidate))
      if (prefix) {
        forbiddenHits.push({ entry, rule: `clone-only prefix ${prefix}` })
        continue
      }
      if (RESIDUE_RE.test(entry)) {
        forbiddenHits.push({ entry, rule: 'archive/log/temp residue' })
        continue
      }
      if (OS_RESIDUE_RE.test(entry)) {
        forbiddenHits.push({ entry, rule: `os residue ${OS_RESIDUE_RE.source}` })
      }
    }
    summary.content.forbidden = forbiddenHits
    if (forbiddenHits.length > 0) {
      fail('content:forbidden', forbiddenHits.map((hit) => `${hit.entry} (${hit.rule})`).join(', '))
    } else {
      ok('content:forbidden', `none of src/tests/scripts/schemas/node_modules/residue among ${files.length} files`)
    }

    // 4 — unpack, then start the CLI with no repo node_modules anywhere on the resolution path.
    process.stdout.write('\n[4/5] unpacked CLI\n')
    const extract = run(`tar -xzf ${quoteArg(tarball)} -C ${quoteArg(tempDir)}`)
    if (extract.status !== 0) {
      fail('unpack', `tar -xzf exited ${extract.status ?? '(no status)'}: ${(extract.stderr ?? '').trim()}`)
      return finish(summary, failures, tempDir, options)
    }
    // npm/pnpm tarballs always unpack into `package/`, next to the tarball itself.
    const unpackedRoot = join(tempDir, 'package')
    const cliRelative = repoPkg.bin && typeof repoPkg.bin.patrol === 'string' ? repoPkg.bin.patrol : 'lib/cli.js'
    const cliPath = join(unpackedRoot, cliRelative)

    let cliSource = null
    try {
      cliSource = readFileSync(cliPath, 'utf8')
    } catch (error) {
      fail('cli:missing', `cannot read ${cliRelative} from the unpacked tarball: ${messageOf(error)}`)
      return finish(summary, failures, tempDir, options)
    }
    if (!cliSource.startsWith('#!')) fail('cli:shebang', `${cliRelative} has no shebang, so the bin shim would not run`)
    else ok('cli:shebang', `${cliRelative} starts with ${cliSource.split(/\r?\n/, 1)[0]}`)

    // Chunk imports count too: lib/cli.js pulls its sources from a hashed sibling chunk.
    const importFiles = [cliPath]
    const chunkRe = /from\s+['"](\.\/[^'"]+\.js)['"]/g
    let chunkMatch
    while ((chunkMatch = chunkRe.exec(cliSource)) !== null) {
      const chunkPath = join(dirname(cliPath), chunkMatch[1].replace(/^\.\//, ''))
      if (!importFiles.includes(chunkPath)) importFiles.push(chunkPath)
    }
    const specifiers = new Set()
    for (const file of importFiles) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const specifier of cliImportSpecifiers(text)) specifiers.add(specifier)
    }
    const bare = [...specifiers].filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    summary.cli.specifiers = [...specifiers].sort()
    summary.cli.selfContained = bare.length === 0
    if (bare.length > 0) fail('cli:self-contained', `bare imports outside node_modules: ${bare.join(', ')}`)
    else ok('cli:self-contained', `${summary.cli.specifiers.length} specifiers, all node: or relative`)

    const env = { ...process.env }
    delete env.NODE_PATH
    delete env.PATROL_SOURCE
    delete env.PATROL_TASKS_FILE

    const helpRun = run(`${quoteArg(process.execPath)} ${quoteArg(cliPath)} --help`, { cwd: unpackedRoot, env })
    summary.cli.command = `node ${cliRelative} --help`
    summary.cli.exitCode = helpRun.status
    const helpOut = `${helpRun.stdout ?? ''}`
    if (helpRun.status !== 0) {
      fail('cli:help', `exit ${helpRun.status ?? '(no status)'}: ${(helpRun.stderr ?? '').trim().split(/\r?\n/).slice(0, 3).join(' | ')}`)
    } else if (!helpOut.includes('用法')) {
      fail('cli:help', `exit 0 but no usage text: ${helpOut.trim().split(/\r?\n/).slice(0, 2).join(' | ')}`)
    } else {
      ok('cli:help', `exit 0, ${helpOut.split(/\r?\n/).filter((l) => l.trim() !== '').length} lines of usage`)
    }

    // A real round of work, not just `--help`: read a two-row table through the packaged CLI.
    const rowsFile = join(tempDir, 'rows.json')
    writeFileSync(
      rowsFile,
      `${JSON.stringify([{ id: 'smoke-1', title: '打包自检行', nextStep: '确认 CLI 能读表', priority: 'P0', repoPath: 'D:\\gitAll\\demo' }], null, 2)}\n`,
      'utf8',
    )
    const rowsRun = run(`${quoteArg(process.execPath)} ${quoteArg(cliPath)} rows --source local-json --tasks-file ${quoteArg(rowsFile)}`, {
      cwd: unpackedRoot,
      env,
    })
    const rowsOut = `${rowsRun.stdout ?? ''}`.trim()
    if (rowsRun.status !== 0 || !rowsOut.includes('smoke-1')) {
      fail('cli:rows', `exit ${rowsRun.status ?? '(no status)'}: ${rowsOut || (rowsRun.stderr ?? '').trim()}`)
    } else {
      ok('cli:rows', `exit 0 → ${rowsOut.split(/\r?\n/)[0]}`)
    }

    // 5 — the version a consumer sees is the version the CHANGELOG documents.
    process.stdout.write('\n[5/5] version consistency\n')
    const packedPkg = JSON.parse(readFileSync(join(unpackedRoot, 'package.json'), 'utf8'))
    if (packedPkg.version !== summary.version) {
      fail('version:tarball', `tarball package.json says ${packedPkg.version}, repo says ${summary.version}`)
    } else {
      ok('version:tarball', `tarball and repo agree on ${summary.version}`)
    }
    let changelogText = ''
    try {
      changelogText = readFileSync(join(unpackedRoot, 'CHANGELOG.md'), 'utf8').replace(/^\uFEFF/, '')
    } catch (error) {
      fail('version:changelog', `cannot read the packed CHANGELOG.md: ${messageOf(error)}`)
    }
    const versions = changelogVersions(changelogText)
    summary.changelogVersion = versions[0] ?? null
    if (versions.length === 0) {
      fail('version:changelog', 'no `## [x.y.z]` heading in the packed CHANGELOG.md')
    } else if (!versions.includes(summary.version)) {
      fail('version:changelog', `package.json is ${summary.version}, CHANGELOG has ${versions.join(', ')}`)
    } else if (versions[0] !== summary.version) {
      fail('version:changelog', `newest CHANGELOG entry is ${versions[0]}, package.json is ${summary.version}`)
    } else {
      ok('version:changelog', `newest entry ${versions[0]} matches package.json`)
    }

    return finish(summary, failures, tempDir, options)
  } catch (error) {
    failures.push({ check: 'unexpected', detail: messageOf(error) })
    return finish(summary, failures, tempDir, options)
  }
}

/**
 * Prints the one-line verdict and the JSON digest, removes the temp directory unless asked to keep
 * it, and returns the exit code. Nothing is published: the tarball is temp-dir-only by design.
 */
function finish(summary, failures, tempDir, options) {
  summary.ok = failures.length === 0
  const lines = []
  lines.push('')
  lines.push(`tarball: ${summary.tarball.file ?? '(none)'}`)
  if (summary.tarball.file) {
    lines.push(`  bytes:   ${summary.tarball.bytes}`)
    lines.push(`  files:   ${summary.tarball.files}`)
    lines.push(`  sha256:  ${summary.tarball.sha256}`)
  }
  lines.push(`version: ${summary.version ?? '(none)'}  changelog: ${summary.changelogVersion ?? '(none)'}`)
  lines.push(`vocabulary: ${summary.vocabulary.kinds ?? '(not loaded)'} kinds, ${summary.vocabulary.problems.length} problem(s)`)
  lines.push(options.keepTemp ? `temp: ${tempDir} (kept)` : 'temp: removed')
  if (failures.length > 0) {
    lines.push('')
    lines.push('failed checks:')
    for (const failure of failures) lines.push(`  - ${failure.check}: ${failure.detail}`)
  }
  lines.push('')
  lines.push(summary.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  lines.push(JSON.stringify({ result: summary.ok ? 'PASS' : 'FAIL', ...summary }))
  process.stdout.write(`${lines.join('\n')}\n`)

  if (!options.keepTemp) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      process.stdout.write(`release-check: could not remove ${tempDir}: ${messageOf(error)}\n`)
    }
  }
  return summary.ok ? 0 : 1
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entry && entry === import.meta.url) process.exitCode = main(process.argv.slice(2))
