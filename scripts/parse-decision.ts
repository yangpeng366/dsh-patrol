#!/usr/bin/env node
/**
 * `parse-decision` — read one model answer to `prompts/decide-next-action.md`, print it as JSON.
 *
 * This is the standalone door to `parseDecisionAnswer()`. `patrol decide <file>` is the other one;
 * both call the same function, so a file that parses here parses there. The script adds only IO and
 * exit codes to the parser:
 *
 *   0  the answer parsed; JSON is on stdout
 *   1  the file is missing, unreadable, or the arguments do not name one file
 *   2  the answer is not in the agreed shape (the parser's `E-*` code names the field)
 *
 * No credential, no network, no model: a bad format and a good one are both reproducible offline,
 * which is what makes the prompt testable at all.
 *
 *   node scripts/parse-decision.ts answer.txt
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { DecisionParseError, parseDecisionAnswer } from '../src/core/decision-answer.ts'

export interface ParseIo {
  out: (text: string) => void
  err: (text: string) => void
}

export const PARSE_USAGE = `用法：
  node scripts/parse-decision.ts <回答文件> [--help]

读模型对 prompts/decide-next-action.md 的回答，只做格式解析，把 JSON 打到 stdout：
  { "action": …, "reason": …, "needsHuman": true|false, "skillNote": …|null, "ignoredLines": [...] }

回答原文：三行 动作: / 理由: / 人工介入: 是|否，可选一行 沉淀: - <做法> — <命令>；
其余非空行记为杂音，进 ignoredLines。

退出码：0 成功；1 参数或文件读取失败；2 回答格式不合规
        （E-MISSING-FIELD / E-DUPLICATE-FIELD / E-EMPTY-FIELD / E-BAD-FLAG，
          冒号后是 ASCII 字段 id action / reason / humanFlag）。`

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs one parse. Returns the exit code instead of calling `process.exit`. */
export async function runDecisionParser(argv: string[], io: ParseIo): Promise<number> {
  const [file, ...rest] = argv
  if (file === '--help' || file === '-h') {
    io.out(PARSE_USAGE)
    return 0
  }
  if (file === undefined || file.trim() === '') {
    io.err('parse-decision: E-NO-INPUT|需要 <回答文件>')
    return 1
  }
  if (rest.length > 0) {
    // One answer per call: accepting a second path would make "which file did it read" ambiguous.
    io.err(`parse-decision: E-BAD-ARG|一次只解析一个文件，多出 ${rest.join(' ')}`)
    return 1
  }

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'E-INPUT-NOT-FOUND' : 'E-READ-FAILED'
    io.err(`parse-decision: ${code}|${file}（${messageOf(error)}）`)
    return 1
  }

  try {
    io.out(JSON.stringify(parseDecisionAnswer(text), null, 2))
    return 0
  } catch (error) {
    if (error instanceof DecisionParseError) {
      // The code, not the prose, is the contract: `stderr` may lose its Chinese to a code page.
      io.err(`parse-decision: ${error.message}`)
      return 2
    }
    io.err(`parse-decision: E-UNEXPECTED|${messageOf(error)}`)
    return 1
  }
}

const invoked = process.argv[1]
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = await runDecisionParser(process.argv.slice(2), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  })
}
