import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
  CATEGORY_TITLES,
  MARKER_END,
  MARKER_START,
  MemoryCategory,
  SyncFailure,
  err,
  ok,
  type Result,
} from './core.ts'
import type { MemoryEntry } from './memory.ts'
import { redact } from './redact.ts'
import { isAnchoredToProject } from './vocabulary.ts'

const MAX_BULLETS_PER_ENTRY = 6
const MAX_BULLET_LENGTH = 280
const MAX_ENTRIES_PER_CATEGORY = 4
const BULLET_PATTERN = /^\s*[-*]\s+(.*)$/
const BARE_LINK_PATTERN = /^\[[^\]]*\]\([^)]*\)[.\s]*$/
const PLACEHOLDER_ONLY_PATTERN = /^[`\s]*\[(?:redacted|local path|phone|email)\]/i
const TRAILING_PLACEHOLDER_PATTERN = /\[(?:redacted|local path|phone|email)\]\s*$/i

const PENDING_WORK_PATTERN =
  /^(?:resolve|address|continue|merge|finalize|prioritize|update|implement|investigate|complete|review|verify|publish|create|add|fix|run|start|prepare|schedule|follow up|send|draft|test|refactor|remove|migrate)\b/i

const SUBJECT_PREFIX_PATTERN = /^(?:you|we|the user|user)\s+/i

const IRREGULAR_PAST_VERBS: ReadonlySet<string> = new Set([
  'began', 'bought', 'brought', 'built', 'came', 'caught', 'chose', 'cut', 'dealt', 'drew',
  'drove', 'fell', 'felt', 'fought', 'found', 'froze', 'gave', 'got', 'grew', 'held', 'hid',
  'hit', 'kept', 'knew', 'laid', 'led', 'left', 'let', 'lit', 'lost', 'made', 'meant', 'met',
  'paid', 'put', 'ran', 'read', 'rewrote', 'rose', 'said', 'sat', 'saw', 'sent', 'set', 'shut',
  'sold', 'sought', 'spent', 'split', 'spoke', 'stood', 'swept', 'taught', 'thought', 'threw',
  'told', 'took', 'troubleshot', 'understood', 'went', 'won', 'wrote',
])

const startsWithPastAction = (bullet: string): boolean => {
  const withoutSubject = bullet.replace(SUBJECT_PREFIX_PATTERN, '')
  const firstWord = /^([A-Za-z]+)/.exec(withoutSubject)?.[1]?.toLowerCase()

  if (!firstWord) return false
  return firstWord.endsWith('ed') || IRREGULAR_PAST_VERBS.has(firstWord)
}

const TITLE_SEGMENT_SEPARATOR = /\s+and\s+/i

export type BlockMetadata = {
  readonly project: string
  readonly windowDays: number
  readonly generatedAt: string
}

export type BulletFilters = {
  readonly vocabulary: ReadonlySet<string>
  readonly deniedTerms: ReadonlyArray<string>
}

const mentionsDeniedTerm = (bullet: string, deniedTerms: ReadonlyArray<string>): boolean => {
  const lowered = bullet.toLowerCase()
  return deniedTerms.some((term) => {
    const trimmed = term.trim().toLowerCase()
    return trimmed.length > 0 && lowered.includes(trimmed)
  })
}

const stripMarkdownEmphasis = (line: string): string => line.replace(/\*\*/g, '').trim()

export const trimTitleToProject = (rawTitle: string, filters: BulletFilters): string => {
  const redacted = redact(rawTitle, filters.deniedTerms).replace(/\s{2,}/g, ' ').trim()
  const segments = redacted.split(TITLE_SEGMENT_SEPARATOR)
  if (segments.length < 2) return redacted

  const anchored = segments.filter((segment) => isAnchoredToProject(segment, filters.vocabulary))
  return anchored.length > 0 ? anchored.join(' and ') : redacted
}

const extractBullets = (text: string, filters: BulletFilters): ReadonlyArray<string> => {
  const bullets: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = BULLET_PATTERN.exec(line)
    if (!match) continue

    const content = stripMarkdownEmphasis(match[1] ?? '')
    if (content.length === 0) continue
    if (BARE_LINK_PATTERN.test(content)) continue
    if (mentionsDeniedTerm(content, filters.deniedTerms)) continue
    if (!isAnchoredToProject(content, filters.vocabulary)) continue

    if (PENDING_WORK_PATTERN.test(content)) continue
    if (!startsWithPastAction(content)) continue

    const scrubbed = redact(content, filters.deniedTerms).replace(/\s{2,}/g, ' ').trim()
    if (scrubbed.length === 0) continue
    if (PLACEHOLDER_ONLY_PATTERN.test(scrubbed)) continue
    if (TRAILING_PLACEHOLDER_PATTERN.test(scrubbed)) continue

    bullets.push(scrubbed.length > MAX_BULLET_LENGTH ? `${scrubbed.slice(0, MAX_BULLET_LENGTH)}…` : scrubbed)
    if (bullets.length === MAX_BULLETS_PER_ENTRY) break
  }

  return bullets
}

const renderEntry = (entry: MemoryEntry, filters: BulletFilters): string | null => {
  const bullets = extractBullets(entry.text, filters)
  if (bullets.length === 0) return null

  const day = entry.createdAt.slice(0, 10)
  const title = trimTitleToProject(entry.title, filters)
  const lines = [`**${title}** — ${day}`, '', ...bullets.map((bullet) => `- ${bullet}`)]
  return lines.join('\n')
}

type RenderedEntry = {
  readonly category: MemoryCategory
  readonly day: string
  readonly body: string
}

const CATEGORY_BY_TITLE: ReadonlyMap<string, MemoryCategory> = new Map(
  Object.values(MemoryCategory).map((category) => [CATEGORY_TITLES[category], category]),
)

const ENTRY_HEADING_PATTERN = /^\*\*(.+)\*\* — (\d{4}-\d{2}-\d{2})$/
const SECTION_HEADING_PATTERN = /^### (.+)$/

export const parseManagedBlock = (existing: string): ReadonlyArray<RenderedEntry> => {
  const start = existing.indexOf(MARKER_START)
  const end = existing.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) return []

  const entries: RenderedEntry[] = []
  let category: MemoryCategory | null = null
  let heading: string | null = null
  let day = ''
  let bullets: string[] = []

  const flush = (): void => {
    if (category === null || heading === null || bullets.length === 0) return
    entries.push({ category, day, body: [heading, '', ...bullets].join('\n') })
  }

  for (const line of existing.slice(start, end).split(/\r?\n/)) {
    const section = SECTION_HEADING_PATTERN.exec(line)
    if (section) {
      flush()
      heading = null
      bullets = []
      category = CATEGORY_BY_TITLE.get(section[1] ?? '') ?? null
      continue
    }

    const entryHeading = ENTRY_HEADING_PATTERN.exec(line)
    if (entryHeading) {
      flush()
      heading = line
      day = entryHeading[2] ?? ''
      bullets = []
      continue
    }

    if (heading !== null && line.startsWith('- ')) bullets.push(line)
  }

  flush()
  return entries
}

export const composeBlock = (
  entries: ReadonlyArray<MemoryEntry>,
  metadata: BlockMetadata,
  filters: BulletFilters,
  previousBlock = '',
): string => {
  const fresh: RenderedEntry[] = []
  for (const entry of entries) {
    const body = renderEntry(entry, filters)
    if (body === null) continue
    fresh.push({ category: entry.category, day: entry.createdAt.slice(0, 10), body })
  }

  const seen = new Set(fresh.map((entry) => entry.body.split('\n')[0]))
  const kept = parseManagedBlock(previousBlock).filter(
    (entry) => !seen.has(entry.body.split('\n')[0]),
  )

  const pool = [...fresh, ...kept].sort((left, right) => right.day.localeCompare(left.day))

  const sections: string[] = [
    MARKER_START,
    '',
    '## Project memory',
    '',
    `Generated by pieces-to-agents from Pieces Long-Term Memory — project "${metadata.project}", last ${metadata.windowDays} days, on ${metadata.generatedAt}.`,
    '',
  ]

  for (const category of Object.values(MemoryCategory)) {
    const rendered = pool
      .filter((entry) => entry.category === category)
      .slice(0, MAX_ENTRIES_PER_CATEGORY)
      .map((entry) => entry.body)

    if (rendered.length === 0) continue

    sections.push(`### ${CATEGORY_TITLES[category]}`, '', ...rendered.flatMap((block) => [block, '']))
  }

  sections.push(MARKER_END)
  return sections.join('\n')
}

export const spliceManagedBlock = (
  existing: string,
  block: string,
): Result<string, SyncFailure> => {
  const startIndex = existing.indexOf(MARKER_START)
  const endIndex = existing.indexOf(MARKER_END)

  if (startIndex === -1 && endIndex === -1) {
    const separator = existing.trimEnd().length === 0 ? '' : `${existing.trimEnd()}\n\n`
    return ok(`${separator}${block}\n`)
  }

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return err(SyncFailure.ManagedBlockConflict)
  }

  const duplicated =
    existing.lastIndexOf(MARKER_START) !== startIndex ||
    existing.lastIndexOf(MARKER_END) !== endIndex
  if (duplicated) return err(SyncFailure.ManagedBlockConflict)

  const before = existing.slice(0, startIndex)
  const after = existing.slice(endIndex + MARKER_END.length)
  return ok(`${before}${block}${after}`)
}

export const readTarget = async (path: string): Promise<Result<string, SyncFailure>> => {
  try {
    return ok(await readFile(path, 'utf8'))
  } catch (caught) {
    if (isMissingFile(caught)) return ok('')
    return err(SyncFailure.ReadFailed)
  }
}

export const writeTarget = async (path: string, content: string): Promise<Result<void, SyncFailure>> => {
  const temporaryPath = `${path}.${process.pid}.pieces-tmp`

  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, path)
    return ok(undefined)
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    return err(SyncFailure.WriteFailed)
  }
}

const isMissingFile = (caught: unknown): boolean =>
  typeof caught === 'object' &&
  caught !== null &&
  'code' in caught &&
  (caught as { code?: unknown }).code === 'ENOENT'
