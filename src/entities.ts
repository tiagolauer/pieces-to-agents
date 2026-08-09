import { foldDiacritics } from './core.ts'

const BULLET_LINE_PATTERN = /^\s*[-*]\s+(.*)$/
const CAPITALIZED_SEQUENCE_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*)*/g
const SENTENCE_BOUNDARY_PATTERN = /[.!?:;]$/
const ALL_CAPS_PATTERN = /^[A-Z0-9]+$/
const MARKDOWN_NOISE_PATTERN = /[`*_[\]]/g
const MINIMUM_CANDIDATE_LENGTH = 3

const STOP_TERMS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'the', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he',
  'she', 'it', 'its', 'his', 'her', 'their', 'our', 'your', 'my',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  'english', 'pieces', 'piecesos', 'github', 'gitlab', 'bitbucket', 'google', 'microsoft',
  'apple', 'amazon', 'windows', 'linux', 'macos', 'ubuntu', 'android', 'chrome', 'firefox',
  'node', 'nodejs', 'javascript', 'typescript', 'python', 'rust', 'java', 'react', 'vue',
  'angular', 'docker', 'kubernetes', 'git', 'npm', 'yarn', 'pnpm', 'powershell', 'bash',
  'claude', 'copilot', 'cursor', 'gemini', 'codex', 'chatgpt', 'openai', 'anthropic',
  'visual', 'studio', 'code', 'markdown', 'json', 'yaml', 'internet', 'web',
  'youtube', 'twitter', 'linkedin', 'reddit', 'slack', 'discord', 'notion', 'trello', 'jira',
])

const isKnownSafe = (word: string, knownTerms: ReadonlySet<string>): boolean => {
  if (ALL_CAPS_PATTERN.test(word)) return true
  const folded = foldDiacritics(word)
  return STOP_TERMS.has(folded) || knownTerms.has(folded)
}

const groupUnknownWords = (
  words: ReadonlyArray<string>,
  knownTerms: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const groups: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length === 0) return
    const candidate = current.join(' ')
    if (candidate.length >= MINIMUM_CANDIDATE_LENGTH) groups.push(candidate)
    current = []
  }

  for (const word of words) {
    if (isKnownSafe(word, knownTerms)) {
      flush()
      continue
    }
    current.push(word)
  }

  flush()
  return groups
}

const scanSentenceText = (
  content: string,
  knownTerms: ReadonlySet<string>,
  found: Map<string, string>,
): void => {
  for (const match of content.matchAll(CAPITALIZED_SEQUENCE_PATTERN)) {
    const preceding = content.slice(0, match.index).trimEnd()
    const atSentenceStart = preceding.length === 0 || SENTENCE_BOUNDARY_PATTERN.test(preceding)

    const words = match[0].split(/\s+/)
    const candidates = groupUnknownWords(atSentenceStart ? words.slice(1) : words, knownTerms)

    for (const candidate of candidates) {
      const folded = foldDiacritics(candidate)
      if (!found.has(folded)) found.set(folded, candidate)
    }
  }
}

export const detectCandidateEntities = (
  text: string,
  knownTerms: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const found = new Map<string, string>()

  for (const line of text.split(/\r?\n/)) {
    const bullet = BULLET_LINE_PATTERN.exec(line)
    if (!bullet) continue

    const content = (bullet[1] ?? '').replace(MARKDOWN_NOISE_PATTERN, '')
    scanSentenceText(content, knownTerms, found)
  }

  return [...found.values()]
}
