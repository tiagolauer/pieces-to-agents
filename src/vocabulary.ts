import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { foldDiacritics } from './core.ts'

const MINIMUM_TERM_LENGTH = 3
const IGNORED_ENTRIES = new Set(['node_modules', '.git', 'dist', 'build', '.github', 'coverage'])
const SEPARATOR_PATTERN = /[^a-z0-9]+/

const PERSON_REFERENCE_PATTERN = /pieces:\/\/persons\//i

const GENERIC_TERMS: ReadonlySet<string> = new Set([
  'api', 'app', 'apps', 'assets', 'bench', 'benchmark', 'bin', 'build', 'cli', 'common', 'config',
  'core', 'coverage', 'data', 'dist', 'doc', 'docs', 'e2e', 'example', 'examples', 'fixture',
  'fixtures', 'helper', 'helpers', 'index', 'integration', 'lib', 'log', 'logs', 'main', 'memory',
  'mock', 'mocks', 'modules', 'node', 'output', 'package', 'public', 'readme', 'scripts', 'server',
  'shared', 'spec', 'specs', 'src', 'temp', 'test', 'tests', 'tmp', 'tools', 'types', 'unit',
  'utils', 'web', 'www',
])

const keep = (term: string): boolean =>
  term.length >= MINIMUM_TERM_LENGTH && !GENERIC_TERMS.has(term)

const addTerm = (into: Set<string>, raw: string): void => {
  const folded = foldDiacritics(raw).trim()
  if (keep(folded)) into.add(folded)

  for (const part of folded.split(SEPARATOR_PATTERN)) {
    if (keep(part)) into.add(part)
  }
}

const readPackageTerms = async (repositoryRoot: string, into: Set<string>): Promise<void> => {
  try {
    const raw = await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return

    const manifest = parsed as {
      name?: unknown
      dependencies?: unknown
      devDependencies?: unknown
    }

    if (typeof manifest.name === 'string') addTerm(into, manifest.name)

    for (const group of [manifest.dependencies, manifest.devDependencies]) {
      if (typeof group !== 'object' || group === null) continue
      for (const dependency of Object.keys(group)) addTerm(into, dependency)
    }
  } catch {
    return
  }
}

export const collectProjectVocabulary = async (
  repositoryRoot: string,
  projectTerms: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const vocabulary = new Set<string>()

  for (const term of projectTerms) addTerm(vocabulary, term)

  try {
    const entries = await readdir(repositoryRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue
      addTerm(vocabulary, entry.name.replace(/\.[a-z0-9]+$/i, ''))

      if (!entry.isDirectory()) continue
      const children = await readdir(join(repositoryRoot, entry.name), { withFileTypes: true })
      for (const child of children) {
        if (IGNORED_ENTRIES.has(child.name) || child.name.startsWith('.')) continue
        addTerm(vocabulary, child.name.replace(/\.[a-z0-9]+$/i, ''))
      }
    }
  } catch {
    // an unreadable directory just yields a smaller vocabulary
  }

  await readPackageTerms(repositoryRoot, vocabulary)

  return vocabulary
}

const containsTermSequence = (
  tokens: ReadonlyArray<string>,
  parts: ReadonlyArray<string>,
): boolean => {
  if (parts.length === 0 || parts.length > tokens.length) return false

  for (let start = 0; start <= tokens.length - parts.length; start += 1) {
    if (parts.every((part, offset) => tokens[start + offset] === part)) return true
  }
  return false
}

export const isAnchoredToProject = (
  bullet: string,
  vocabulary: ReadonlySet<string>,
): boolean => {
  if (PERSON_REFERENCE_PATTERN.test(bullet)) return false

  const tokens = foldDiacritics(bullet).split(SEPARATOR_PATTERN).filter((word) => word.length > 0)
  const words = new Set(tokens)

  for (const term of vocabulary) {
    if (words.has(term)) return true

    const parts = term.split(SEPARATOR_PATTERN).filter((part) => part.length > 0)
    if (parts.length > 1 && containsTermSequence(tokens, parts)) return true
  }
  return false
}
