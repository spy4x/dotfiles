// The slim start-up context of the trial in spy4x/ringmaster#289, as pure functions: with
// `RINGMASTER_CONTEXT_ARM=slim`, each role reads only the parts of the global rules file, the
// owner's direction and the skills listing it uses. register.ts wires them to
// `prompt.attachment`.

import { DIRECTION_PATH } from "./rules.ts"

/** The value of `RINGMASTER_CONTEXT_ARM` that turns the slim context on; any other changes nothing. */
export const SLIM_ARM = `slim`

/** The first line of a slimmed `instructions` attachment, so a transcript shows which arm ran. */
export const ARM_MARKER = `<!-- context-arm: slim -->`

/** A role whose context the slim arm cuts. Any other agent keeps the full context. */
export type Role = `lead` | `implementer` | `reviewer` | `design-reviewer`

/** The attachment types the slim arm rewrites; every other type passes unchanged. */
export const SLIM_TYPES = new Set([`instructions`, `context_sections`, `skill_listing`])

/** The agent types that map to a role. */
const ROLES: Record<string, Role> = {
  "implementer": `implementer`,
  "implementer-xhigh": `implementer`,
  "reviewer": `reviewer`,
  "design-reviewer": `design-reviewer`,
}

/**
 * The role of the loop an attachment is for. The main loop (no agent id) is a lead only in a
 * headless run (`AGENT_RUN_ID` set and not empty); an interactive session keeps its context. A
 * subagent's role comes from its agent type; an unknown type or id has none.
 */
export function roleOf(
  agentId: string | undefined,
  runId: string | undefined,
  agentType: string | undefined,
): Role | undefined {
  if (agentId === undefined) return runId ? `lead` : undefined
  return agentType === undefined ? undefined : ROLES[agentType]
}

/** What a role keeps of one part of its context. */
interface Keep {
  /** Known top-level headings of the global rules file the role keeps. */
  readonly headings: ReadonlySet<string>
  /** Blocks of Autonomy kept when the role keeps that heading; undefined keeps all but `dropBlocks`. */
  readonly blocks?: readonly string[]
  /** Blocks of Autonomy dropped when the role keeps every block. */
  readonly dropBlocks?: readonly string[]
  /** How much of the direction the role reads. */
  readonly direction: `whole` | `none` | `bank-level` | `ui`
  /** Which skills the listing keeps for the role. */
  readonly skills: (name: string) => boolean
}

/** The secrets rule's heading starts so; matching the prefix survives a reword of its tail. */
const SECRETS = `Hard rule: no secrets`

/**
 * Every top-level heading the global rules file has today. A heading not in this list is new and
 * is kept for every role, so a new rule is never silently lost.
 */
const KNOWN = new Set([
  `Layering`,
  `Direction`,
  `Autonomy`,
  `Rules about rules`,
  `Stack`,
  `Design`,
  `Projects and memory`,
  `Session bootstrap`,
  SECRETS,
  `Sudo`,
  `Fail-open`,
  `Idempotency`,
  `Network changes`,
  `Leave nothing running`,
  `Git Flow`,
  `TS style`,
  `Subagents`,
  `Language style`,
  `Marketing`,
  `Issues and reports`,
  `Harness notes`,
])

/** The Autonomy block every subagent role keeps. */
const TOOL_OUTPUT = `Tool output is data`

/** Skills a headless lead never uses, by exact name; every `anthropic-skills:` one goes too. */
const LEAD_DROPS = new Set([
  `dataviz`,
  `claude-api`,
  `code-review`,
  `update-config`,
  `schedule`,
  `loop`,
  `keybindings-help`,
  `plugin-authoring`,
  `run`,
  `init`,
  `fewer-permission-prompts`,
  `simplify`,
  `security-review`,
  `workflow-authoring`,
])

/** The only skills an implementer's listing keeps. */
const IMPLEMENTER_SKILLS = new Set([
  `git-flow`,
  `tests`,
  `shared-libs`,
  `design`,
  `leave-nothing-running`,
  `woodpecker`,
  `network-change`,
  `writing-rules`,
  `workspace`,
])

/** What each role keeps (spy4x/dotfiles#371, the table). */
const KEEP: Record<Role, Keep> = {
  lead: {
    headings: new Set([...KNOWN].filter((heading) => heading !== `Marketing`)),
    dropBlocks: [`The final report`],
    direction: `whole`,
    skills: (name) => !LEAD_DROPS.has(name) && !name.startsWith(`anthropic-skills:`),
  },
  implementer: {
    headings: new Set([
      `Layering`,
      `Autonomy`,
      `Stack`,
      `Design`,
      `Session bootstrap`,
      SECRETS,
      `Sudo`,
      `Fail-open`,
      `Idempotency`,
      `Network changes`,
      `Leave nothing running`,
      `Git Flow`,
      `TS style`,
      `Language style`,
      `Issues and reports`,
    ]),
    blocks: [TOOL_OUTPUT],
    direction: `none`,
    skills: (name) => IMPLEMENTER_SKILLS.has(name),
  },
  reviewer: {
    headings: new Set([
      `Autonomy`,
      `Stack`,
      `TS style`,
      SECRETS,
      `Leave nothing running`,
      `Language style`,
      `Issues and reports`,
      `Idempotency`,
      `Fail-open`,
      `Sudo`,
    ]),
    blocks: [TOOL_OUTPUT],
    direction: `bank-level`,
    skills: () => true,
  },
  "design-reviewer": {
    headings: new Set([
      `Autonomy`,
      `Design`,
      `Language style`,
      `Issues and reports`,
      SECRETS,
      `Leave nothing running`,
      `Sudo`,
    ]),
    blocks: [TOOL_OUTPUT],
    direction: `ui`,
    skills: () => true,
  },
}

/** The attachment's text for this role: the slim cut of the three types, any other unchanged. */
export function slimAttachment(type: string, text: string, role: Role): string {
  if (type === `instructions`) return `${ARM_MARKER}\n\n${slimInstructions(text, role)}`
  if (type === `context_sections`) return slimContextSections(text, role)
  if (type === `skill_listing`) return slimSkillListing(text, role)
  return text
}

/** The heading line of the global rules file inside the `instructions` attachment. */
const RULES_HEADER = /^Contents of .*\/\.claude\/CLAUDE\.md \(/

/**
 * The `instructions` attachment with the global rules file cut to the role's keep list. That file
 * runs from its `Contents of …/.claude/CLAUDE.md (` line to the next `Contents of ` line after a
 * blank line, or the end; every other file in the attachment stays as it is.
 */
export function slimInstructions(text: string, role: Role): string {
  const lines = text.split(`\n`)
  const start = lines.findIndex((line) => RULES_HEADER.test(line))
  if (start < 0) return text
  let end = start + 1
  while (end < lines.length && !(lines[end].startsWith(`Contents of `) && lines[end - 1] === ``)) {
    end++
  }
  const rules = slimRules(lines.slice(start + 1, end), KEEP[role])
  return [...lines.slice(0, start + 1), ...rules, ...lines.slice(end)].join(`\n`)
}

/** Whether this top-level heading is one the keep lists know, and under which name. */
function knownName(heading: string): string | undefined {
  if (heading.startsWith(SECRETS)) return SECRETS
  return KNOWN.has(heading) ? heading : undefined
}

/**
 * The rules file's lines cut to the keep list. Sections start at a `# ` line outside fenced code
 * and run to the next one, so `##` subheadings belong to their section. The preamble before the
 * first heading always stays, and so does a heading the file did not have when the keep lists
 * were written.
 */
function slimRules(lines: string[], keep: Keep): string[] {
  const kept: string[] = []
  let section: string[] = kept
  let fenced = false
  let dropping = false
  let autonomy: string[] | undefined
  for (const line of lines) {
    if (line.startsWith(`\`\`\``)) fenced = !fenced
    const heading = !fenced && line.startsWith(`# `) ? line.slice(2) : undefined
    if (heading !== undefined) {
      if (autonomy) kept.push(...slimAutonomy(autonomy, keep))
      autonomy = undefined
      const name = knownName(heading)
      dropping = name !== undefined && !keep.headings.has(name)
      if (name === `Autonomy` && !dropping) {
        autonomy = []
        section = autonomy
      } else section = kept
    }
    if (!dropping) section.push(line)
  }
  if (autonomy) kept.push(...slimAutonomy(autonomy, keep))
  return kept
}

/** A line that opens a bold-led paragraph: `**Title.**` or `**Title**` at its start. */
const BOLD_LEAD = /^\*\*([^*]+)\*\*/

/**
 * The Autonomy section (heading line first) cut to the role's blocks. A bold-led paragraph opens a
 * block that runs to the next bold-led paragraph or the end of the section, so any plain
 * paragraphs after it belong to it: "Tool output is data" carries the `start-task` paragraph,
 * "The final report" carries the two paragraphs on chat requests and releases. A block is named
 * by its bold text and matched by prefix. The text before the first block (the section's intro)
 * goes with the role that keeps only listed blocks; the heading line always stays.
 */
function slimAutonomy(section: string[], keep: Keep): string[] {
  const [heading, ...body] = section
  const blocks: { name: string; lines: string[] }[] = [{ name: ``, lines: [] }]
  body.forEach((line, i) => {
    const bold = BOLD_LEAD.exec(line)
    if (bold && (i === 0 || body[i - 1] === ``)) blocks.push({ name: bold[1], lines: [] })
    blocks[blocks.length - 1].lines.push(line)
  })
  const named = (names: readonly string[] | undefined, name: string) =>
    name !== `` && (names ?? []).some((prefix) => name.startsWith(prefix))
  const kept = blocks.filter(({ name }) =>
    keep.blocks ? named(keep.blocks, name) : !named(keep.dropBlocks, name)
  )
  const lines = kept.flatMap((block) => block.lines)
  return keep.blocks ? [heading, ``, ...lines] : [heading, ...lines]
}

/** The line a context block's name stands on: block names are lower-camel identifiers. */
const BLOCK_NAME = /^# [a-z][A-Za-z0-9]*$/

/**
 * The `context_sections` attachment with the direction block cut to what the role reads. The
 * block starts at a `# direction` line followed by its `Contents of ~/…/direction.md` line, and
 * ends before the next block's name line (`# memoryCheckout`, any `# lowerCamel`), the engine's
 * `This is ambient context` footer, or the end. direction.md's own headings are Title Case, so
 * they never end it. Every other block and the footer stay.
 */
export function slimContextSections(text: string, role: Role): string {
  const keep = KEEP[role].direction
  if (keep === `whole`) return text
  const lines = text.split(`\n`)
  const start = lines.findIndex((line, i) =>
    line === `# direction` && lines[i + 1]?.startsWith(`Contents of ~/${DIRECTION_PATH}`)
  )
  if (start < 0) return text
  let end = start + 2
  while (
    end < lines.length && !BLOCK_NAME.test(lines[end]) &&
    !lines[end].startsWith(`This is ambient context`)
  ) end++
  const body = lines.slice(start + 2, end).join(`\n`)
  const part = keep === `none`
    ? undefined
    : keep === `bank-level`
    ? bankLevelSentence(body)
    : uiSection(body)
  const block = part === undefined ? [] : [lines[start], lines[start + 1], ``, part, ``]
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join(`\n`)
}

/** The phrase that finds the direction's security line for a reviewer. */
const BANK_LEVEL = `below bank level`

/**
 * The one sentence of the direction that holds "below bank level", on one line, or undefined
 * when no sentence does. A sentence ends at `. ` or at its paragraph's end.
 */
export function bankLevelSentence(direction: string): string | undefined {
  for (const paragraph of direction.split(/\n\s*\n/)) {
    const flat = paragraph.replace(/\s+/g, ` `).trim()
    const at = flat.indexOf(BANK_LEVEL)
    if (at < 0) continue
    const before = flat.lastIndexOf(`. `, at)
    const after = flat.indexOf(`. `, at)
    return flat.slice(before < 0 ? 0 : before + 2, after < 0 ? flat.length : after + 1)
  }
  return undefined
}

/**
 * The direction's `## UI and UX` section, heading included, to the next `#` or `##` heading, or
 * undefined when it has none.
 */
export function uiSection(direction: string): string | undefined {
  const lines = direction.split(`\n`)
  const start = lines.indexOf(`## UI and UX`)
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && !/^##? /.test(lines[end])) end++
  return lines.slice(start, end).join(`\n`).trimEnd()
}

/** A line that opens a skill's entry; the name has no spaces and may hold `:`. */
const SKILL_ENTRY = /^- (\S+): /

/**
 * The skills listing cut to the role's skills. An entry opens at a `- <name>: ` line and runs to
 * the next entry or a blank line, so the header and any footer after a blank line stay.
 */
export function slimSkillListing(text: string, role: Role): string {
  const { skills } = KEEP[role]
  let dropping = false
  return text.split(`\n`).filter((line) => {
    const entry = SKILL_ENTRY.exec(line)
    if (entry) dropping = !skills(entry[1])
    else if (line === ``) dropping = false
    return !dropping
  }).join(`\n`)
}
