/**
 * Loads the skill that ships inside this package.
 *
 * DSH's filesystem skill provider only scans a workspace, so a skill packaged inside a plugin
 * stays invisible to the host unless the plugin registers it itself. The packaged file is the
 * single source of truth: the same body is read by the host and by the tests.
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PackagedSkill {
  /** Kebab-case skill name, taken from the frontmatter. */
  name: string
  /** One-line routing description, taken from the frontmatter. */
  description: string
  /** Markdown body after the frontmatter. */
  content: string
  /** Absolute path of the SKILL.md that was read. */
  path: string
}

/**
 * Reads `skills/<name>/SKILL.md` relative to this module.
 *
 * @param name - Directory name of the packaged skill.
 * @param from - Module URL to resolve against; defaults to this module.
 * @throws Error when the file is missing, empty, or has no frontmatter.
 */
export function readPackagedSkill(name: string, from: string = import.meta.url): PackagedSkill {
  const path = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, from))
  let text: string
  try {
    text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  } catch (error) {
    throw new Error(`Missing packaged skill: ${path}`, { cause: error })
  }
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}

/** Directory that holds the packaged skill, used as the skill's resource base. */
export function skillResourceBase(skill: PackagedSkill): { kind: 'directory'; path: string } {
  return { kind: 'directory', path: dirname(skill.path) }
}
