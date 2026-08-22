import { constants } from 'node:fs'
import { lstat, open, opendir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { foldDiacritics, stripByteOrderMark } from './core.ts'

const MINIMUM_TERM_LENGTH = 3
const MAXIMUM_TERM_LENGTH = 256
const MAXIMUM_VOCABULARY_TERMS = 5_000
const MAXIMUM_MANIFEST_BYTES = 256 * 1_024
const MAXIMUM_CSPROJ_FILES = 128
const MAXIMUM_CSPROJ_DIRECTORIES = 256
const MAXIMUM_CSPROJ_ENTRIES = 10_000
const MAXIMUM_TERMS_PER_MANIFEST_SOURCE = 600
const MANIFEST_OPEN_FLAGS = constants.O_RDONLY
  | (constants.O_NONBLOCK ?? 0)
  | (constants.O_NOFOLLOW ?? 0)
const IGNORED_ENTRIES = new Set(['node_modules', '.git', 'dist', 'build', '.github', 'coverage'])
const IGNORED_MANIFEST_DIRECTORIES = new Set([...IGNORED_ENTRIES, 'bin', 'obj', 'target', 'vendor', 'venv'])
const SEPARATOR_PATTERN = /[^a-z0-9]+/
const ROOT_SOURCE_PATTERN = /\.(?:asm|bash|c|cc|clj|cljs|cpp|cs|css|cu|dart|elm|erl|ex|exs|f|f90|fs|fsx|go|groovy|h|hpp|hs|java|jl|js|jsx|kt|kts|less|lua|m|mm|mjs|mts|nim|php|pl|pm|ps1|py|r|rb|rs|sass|scala|scss|sh|sol|sql|svelte|swift|tf|ts|tsx|vb|vue|zig|zsh)$/i

const PERSON_REFERENCE_PATTERN = /pieces:\/\/persons\//i
const TOML_SECTION_PATTERN = /^\s*\[([^\]]+)]\s*(?:#.*)?$/
const TOML_ASSIGNMENT_PATTERN = /^\s*(?:"([^"]+)"|'([^']+)'|([a-z0-9_.-]+))\s*=\s*(.*)$/i
const PYTHON_DEPENDENCY_PATTERN = /^\s*([a-z0-9][a-z0-9._-]*)/i
const CARGO_DEPENDENCY_SECTION_PATTERN = /^(?:(?:target\..+|workspace)\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/
const COMPOSER_PLATFORM_DEPENDENCY_PATTERN = /^(?:composer(?:-(?:plugin|runtime)-api)?$|ext-|hhvm$|lib-|php(?:-(?:64bit|debug|ipv6|zts))?$)/i

const GENERIC_TERMS: ReadonlySet<string> = new Set([
  'agent', 'agents', 'api', 'app', 'apps', 'assets', 'bench', 'benchmark', 'bin', 'bitbucket', 'build', 'claude',
  'cli', 'codex', 'com', 'common', 'component', 'components', 'config', 'console', 'constants', 'context', 'copilot',
  'core', 'coverage', 'cursor', 'data', 'dist', 'doc', 'docs', 'e2e', 'example', 'examples',
  'fixture', 'fixtures', 'gemini', 'helper', 'helpers', 'hook', 'hooks', 'index', 'integration', 'json',
  'architecture', 'dev', 'github', 'gitlab', 'golang', 'layout', 'layouts', 'lib', 'license', 'log', 'logs',
  'main', 'memory', 'middleware', 'migration', 'migrations', 'mock', 'mocks', 'model', 'models',
  'modules', 'net', 'node', 'org', 'output', 'package', 'page', 'pkg',
  'pages', 'provider', 'providers', 'public', 'readme', 'route', 'routes', 'runtime', 'schema', 'schemas',
  'scripts', 'security', 'server', 'service', 'services', 'shared', 'spec', 'specs', 'src', 'state', 'store',
  'style', 'styles', 'sync', 'temp', 'test', 'tests', 'tmp', 'tools', 'types', 'unit', 'utils', 'view',
  'views', 'web', 'worker', 'www',
])

const keep = (term: string): boolean =>
  term.length >= MINIMUM_TERM_LENGTH && !GENERIC_TERMS.has(term)

const addTerm = (into: Set<string>, raw: string, alwaysKeepWhole = false): void => {
  if (into.size >= MAXIMUM_VOCABULARY_TERMS || raw.length > MAXIMUM_TERM_LENGTH) return

  const folded = foldDiacritics(raw).trim()
  if (folded.length > 0 && (alwaysKeepWhole || keep(folded))) into.add(folded)

  for (const part of folded.split(SEPARATOR_PATTERN)) {
    if (into.size >= MAXIMUM_VOCABULARY_TERMS) break
    if (keep(part)) into.add(part)
  }
}

const readOptionalText = async (path: string): Promise<string | null> => {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const pathStats = await lstat(path)
    if (!pathStats.isFile() || pathStats.size > MAXIMUM_MANIFEST_BYTES) return null

    handle = await open(path, MANIFEST_OPEN_FLAGS)
    const fileStats = await handle.stat()
    if (
      !fileStats.isFile()
      || fileStats.size > MAXIMUM_MANIFEST_BYTES
      || fileStats.dev !== pathStats.dev
      || fileStats.ino !== pathStats.ino
    ) return null

    const expectedBytes = fileStats.size
    const buffer = Buffer.allocUnsafe(expectedBytes + 1)
    let totalBytes = 0
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      )
      if (bytesRead === 0) break
      totalBytes += bytesRead
    }
    if (totalBytes !== expectedBytes) return null
    return stripByteOrderMark(buffer.subarray(0, totalBytes).toString('utf8'))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const readJsonManifestTerms = async (
  repositoryRoot: string,
  filename: string,
  dependencyGroups: ReadonlyArray<string>,
  into: Set<string>,
  priorityInto: Set<string>,
): Promise<void> => {
  const raw = await readOptionalText(join(repositoryRoot, filename))
  if (raw === null) return

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return

    const manifest = parsed as Readonly<Record<string, unknown>>

    if (typeof manifest.name === 'string') addTerm(priorityInto, manifest.name)

    for (const groupName of dependencyGroups) {
      const group = manifest[groupName]
      if (typeof group !== 'object' || group === null) continue
      for (const dependency of Object.keys(group)) {
        if (filename === 'composer.json' && COMPOSER_PLATFORM_DEPENDENCY_PATTERN.test(dependency)) continue
        addTerm(into, dependency)
      }
    }
  } catch {
    return
  }
}

const matchTomlAssignment = (line: string): readonly [string, string] | null => {
  const match = line.match(TOML_ASSIGNMENT_PATTERN)
  const key = match?.[1] ?? match?.[2] ?? match?.[3]
  const value = match?.[4]
  return key === undefined || value === undefined ? null : [key, value]
}

const findUnquotedCharacter = (line: string, target: string): number => {
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === undefined) break

    if (quote !== null) {
      if (quote === '"' && character === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (character === quote && !escaped) quote = null
      escaped = false
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === target) return index
  }

  return -1
}

const stripTomlComment = (line: string): string => {
  const commentIndex = findUnquotedCharacter(line, '#')
  return commentIndex < 0 ? line : line.slice(0, commentIndex)
}

const closesTomlArray = (line: string): boolean => findUnquotedCharacter(line, ']') >= 0

type TomlMultilineDelimiter = '"""' | "'''" | null

const isEscaped = (line: string, index: number): boolean => {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

const findTomlMultilineClose = (
  line: string,
  delimiter: Exclude<TomlMultilineDelimiter, null>,
  fromIndex: number,
): number => {
  let index = line.indexOf(delimiter, fromIndex)
  while (index >= 0 && delimiter === '"""' && isEscaped(line, index)) {
    index = line.indexOf(delimiter, index + delimiter.length)
  }
  return index
}

const stripTomlMultilineContent = (
  line: string,
  initialDelimiter: TomlMultilineDelimiter,
): readonly [string, TomlMultilineDelimiter] => {
  let delimiter = initialDelimiter
  let quote: '"' | "'" | null = null
  let escaped = false
  let result = ''

  for (let index = 0; index < line.length; index += 1) {
    if (delimiter !== null) {
      const closingIndex = findTomlMultilineClose(line, delimiter, index)
      if (closingIndex < 0) {
        result += JSON.stringify(line.slice(index))
        break
      }
      result += JSON.stringify(line.slice(index, closingIndex))
      index = closingIndex + delimiter.length - 1
      delimiter = null
      continue
    }

    const character = line[index]
    if (character === undefined) break

    if (quote !== null) {
      result += character
      if (quote === '"' && character === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (character === quote && !escaped) quote = null
      escaped = false
      continue
    }

    if (character === '#') {
      result += line.slice(index)
      break
    }

    const openingDelimiter = line.startsWith('"""', index)
      ? '"""'
      : line.startsWith("'''", index) ? "'''" : null
    if (openingDelimiter !== null) {
      const contentStart = index + openingDelimiter.length
      const closingIndex = findTomlMultilineClose(line, openingDelimiter, contentStart)
      if (closingIndex < 0) {
        result += JSON.stringify(line.slice(contentStart))
        delimiter = openingDelimiter
        break
      }
      result += JSON.stringify(line.slice(contentStart, closingIndex))
      index = closingIndex + openingDelimiter.length - 1
      continue
    }

    if (character === '"' || character === "'") quote = character
    result += character
  }

  return [result, delimiter]
}

const addPythonDependencies = (into: Set<string>, value: string): void => {
  for (const match of value.matchAll(/["']([^"']+)["']/g)) {
    const dependency = match[1]?.match(PYTHON_DEPENDENCY_PATTERN)?.[1]
    if (dependency !== undefined) addTerm(into, dependency)
  }
}

const readPyprojectTerms = async (
  repositoryRoot: string,
  into: Set<string>,
  priorityInto: Set<string>,
): Promise<void> => {
  const raw = await readOptionalText(join(repositoryRoot, 'pyproject.toml'))
  if (raw === null) return

  let section = ''
  let collectingDependencies = false
  let multilineDelimiter: TomlMultilineDelimiter = null

  for (const rawLine of raw.split(/\r?\n/)) {
    const [withoutMultilineContent, nextDelimiter] = stripTomlMultilineContent(
      rawLine,
      multilineDelimiter,
    )
    multilineDelimiter = nextDelimiter
    const line = stripTomlComment(withoutMultilineContent)
    const sectionMatch = line.match(TOML_SECTION_PATTERN)
    if (sectionMatch !== null) {
      section = sectionMatch[1]?.trim().toLowerCase() ?? ''
      collectingDependencies = false
      continue
    }

    if (collectingDependencies) {
      addPythonDependencies(into, line)
      if (closesTomlArray(line)) collectingDependencies = false
      continue
    }

    const assignment = matchTomlAssignment(line)
    if (assignment === null) continue
    const [key, value] = assignment

    if ((section === 'project' || section === 'tool.poetry') && key === 'name') {
      const name = value.match(/^\s*["']([^"']+)["']/)?.[1]
      if (name !== undefined) addTerm(priorityInto, name)
      continue
    }

    if (section === 'project' && key === 'dependencies') {
      addPythonDependencies(into, value)
      collectingDependencies = !closesTomlArray(value)
      continue
    }

    if (section === 'project.optional-dependencies') {
      addPythonDependencies(into, value)
      collectingDependencies = !closesTomlArray(value)
      continue
    }

    if (/^tool\.poetry(?:\.group\.[^.]+)?\.dependencies$/.test(section) && key !== 'python') {
      addTerm(into, key)
    }
  }
}

const readGoModTerms = async (
  repositoryRoot: string,
  into: Set<string>,
  priorityInto: Set<string>,
): Promise<void> => {
  const raw = await readOptionalText(join(repositoryRoot, 'go.mod'))
  if (raw === null) return

  let collectingRequirements = false

  for (const line of raw.split(/\r?\n/)) {
    const value = line.replace(/\/\/.*$/, '').trim()
    if (value.length === 0) continue

    if (collectingRequirements) {
      if (value === ')') {
        collectingRequirements = false
        continue
      }
      const dependency = value.split(/\s+/, 1)[0]
      if (dependency !== undefined) addTerm(into, dependency.replace(/^['"]|['"]$/g, ''))
      continue
    }

    const moduleName = value.match(/^module\s+([^\s]+)/)?.[1]
    if (moduleName !== undefined) {
      addTerm(priorityInto, moduleName.replace(/^['"]|['"]$/g, ''))
      continue
    }

    if (/^require\s*\($/.test(value)) {
      collectingRequirements = true
      continue
    }

    const dependency = value.match(/^require\s+([^\s]+)/)?.[1]
    if (dependency !== undefined) addTerm(into, dependency.replace(/^['"]|['"]$/g, ''))
  }
}

const readCargoTerms = async (
  repositoryRoot: string,
  into: Set<string>,
  priorityInto: Set<string>,
): Promise<void> => {
  const raw = await readOptionalText(join(repositoryRoot, 'Cargo.toml'))
  if (raw === null) return

  let section = ''
  let dependencyTable = false
  let multilineDelimiter: TomlMultilineDelimiter = null

  for (const rawLine of raw.split(/\r?\n/)) {
    const [withoutMultilineContent, nextDelimiter] = stripTomlMultilineContent(
      rawLine,
      multilineDelimiter,
    )
    multilineDelimiter = nextDelimiter
    const line = stripTomlComment(withoutMultilineContent)
    const sectionMatch = line.match(TOML_SECTION_PATTERN)
    if (sectionMatch !== null) {
      section = sectionMatch[1]?.trim().toLowerCase() ?? ''
      const dependencySection = section.match(CARGO_DEPENDENCY_SECTION_PATTERN)
      dependencyTable = dependencySection !== null && dependencySection[1] === undefined
      const dependency = dependencySection?.[1]
      if (dependency !== undefined) addTerm(into, dependency.replace(/^["']|["']$/g, ''))
      continue
    }

    const assignment = matchTomlAssignment(line)
    if (assignment === null) continue
    const [key, value] = assignment

    if (section === 'package' && key === 'name') {
      const name = value.match(/^\s*["']([^"']+)["']/)?.[1]
      if (name !== undefined) addTerm(priorityInto, name)
      continue
    }

    if (dependencyTable) addTerm(into, key)
  }
}

const findCsprojPaths = async (repositoryRoot: string): Promise<ReadonlyArray<string>> => {
  const directories = [repositoryRoot]
  const paths: string[] = []
  let inspectedEntries = 0

  for (
    let index = 0;
    index < directories.length
      && index < MAXIMUM_CSPROJ_DIRECTORIES
      && paths.length < MAXIMUM_CSPROJ_FILES;
    index += 1
  ) {
    const directory = directories[index]
    if (directory === undefined) break

    try {
      const directoryHandle = await opendir(directory)
      for await (const entry of directoryHandle) {
        inspectedEntries += 1
        if (inspectedEntries > MAXIMUM_CSPROJ_ENTRIES) return paths
        if (entry.name.startsWith('.')) continue

        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (
            !IGNORED_MANIFEST_DIRECTORIES.has(entry.name.toLowerCase())
            && directories.length < MAXIMUM_CSPROJ_DIRECTORIES
          ) directories.push(path)
          continue
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.csproj')) paths.push(path)
        if (paths.length >= MAXIMUM_CSPROJ_FILES) break
      }
    } catch {
      continue
    }
  }

  return paths
}

const stripXmlInertContent = (xml: string): string => {
  const lowercaseXml = xml.toLowerCase()
  let cursor = 0
  let result = ''

  while (cursor < xml.length) {
    const commentStart = xml.indexOf('<!--', cursor)
    const cdataStart = xml.indexOf('<![CDATA[', cursor)
    const processingInstructionStart = xml.indexOf('<?', cursor)
    const doctypeStart = lowercaseXml.indexOf('<!doctype', cursor)
    const starts = [commentStart, cdataStart, processingInstructionStart, doctypeStart]
      .filter((index) => index >= 0)
    if (starts.length === 0) {
      result += xml.slice(cursor)
      break
    }
    const declarationStart = Math.min(...starts)

    result += xml.slice(cursor, declarationStart)
    if (declarationStart === commentStart) {
      const end = xml.indexOf('-->', declarationStart + 4)
      cursor = end < 0 ? xml.length : end + 3
      continue
    }
    if (declarationStart === cdataStart) {
      const end = xml.indexOf(']]>', declarationStart + 9)
      cursor = end < 0 ? xml.length : end + 3
      continue
    }
    if (declarationStart === processingInstructionStart) {
      const end = xml.indexOf('?>', declarationStart + 2)
      cursor = end < 0 ? xml.length : end + 2
      continue
    }

    let quote: '"' | "'" | null = null
    let subsetDepth = 0
    let end = xml.length
    for (let index = declarationStart + 9; index < xml.length; index += 1) {
      const character = xml[index]
      if (character === undefined) break
      if (quote !== null) {
        if (character === quote) quote = null
        continue
      }
      if (xml.startsWith('<!--', index)) {
        const commentEnd = xml.indexOf('-->', index + 4)
        if (commentEnd < 0) break
        index = commentEnd + 2
        continue
      }
      if (xml.startsWith('<?', index)) {
        const instructionEnd = xml.indexOf('?>', index + 2)
        if (instructionEnd < 0) break
        index = instructionEnd + 1
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === '[') subsetDepth += 1
      if (character === ']') subsetDepth = Math.max(0, subsetDepth - 1)
      if (character === '>' && subsetDepth === 0) {
        end = index + 1
        break
      }
    }
    cursor = end
  }

  return result
}

const readCsprojTerms = async (
  repositoryRoot: string,
  into: Set<string>,
  priorityInto: Set<string>,
): Promise<void> => {
  for (const path of await findCsprojPaths(repositoryRoot)) {
    const raw = await readOptionalText(path)
    if (raw === null) continue

    const xml = stripXmlInertContent(raw)
    if (!/<Project\b/i.test(xml) || !/<\/Project>/i.test(xml)) continue
    addTerm(priorityInto, basename(path).replace(/\.csproj$/i, ''))

    for (const match of xml.matchAll(/<AssemblyName\b[^<>]*>\s*([^<]+?)\s*<\/AssemblyName>/gi)) {
      const assemblyName = match[1]
      if (assemblyName !== undefined) addTerm(priorityInto, assemblyName)
    }

    for (const match of xml.matchAll(/<PackageReference\b[^<>]*(?:Include|Update)\s*=\s*["']([^"']+)["']/gi)) {
      const dependency = match[1]
      if (dependency !== undefined) addTerm(into, dependency)
    }
  }
}

type RubyHeredoc = {
  readonly allowIndentedEnd: boolean
  readonly delimiter: string
}

const findRubyHeredocs = (line: string): ReadonlyArray<RubyHeredoc> => {
  const heredocs: RubyHeredoc[] = []
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === undefined) break

    if (quote !== null) {
      if (character === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (character === quote && !escaped) quote = null
      escaped = false
      continue
    }

    if (character === '#') break
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (!line.startsWith('<<', index)) continue

    let delimiterStart = index + 2
    const modifier = line[delimiterStart]
    if (modifier === '-' || modifier === '~') delimiterStart += 1

    const delimiterQuote = line[delimiterStart] === '"' || line[delimiterStart] === "'"
      ? line[delimiterStart]
      : null
    if (delimiterQuote !== null) delimiterStart += 1

    const delimiter = line.slice(delimiterStart).match(/^[a-z_][a-z0-9_]*/i)?.[0]
    if (delimiter === undefined) continue
    const delimiterEnd = delimiterStart + delimiter.length
    if (delimiterQuote !== null && line[delimiterEnd] !== delimiterQuote) continue

    heredocs.push({ allowIndentedEnd: modifier === '-' || modifier === '~', delimiter })
    index = delimiterEnd + (delimiterQuote === null ? -1 : 0)
  }

  return heredocs
}

const readGemfileTerms = async (repositoryRoot: string, into: Set<string>): Promise<void> => {
  const raw = await readOptionalText(join(repositoryRoot, 'Gemfile'))
  if (raw === null) return

  let blockComment = false
  const heredocs: RubyHeredoc[] = []
  for (const line of raw.split(/\r?\n/)) {
    const heredoc = heredocs[0]
    if (heredoc !== undefined) {
      const end = heredoc.allowIndentedEnd ? line.trim() : line
      if (end === heredoc.delimiter) heredocs.shift()
      continue
    }
    if (/^\s*=begin\b/.test(line)) {
      blockComment = true
      continue
    }
    if (/^\s*=end\b/.test(line)) {
      blockComment = false
      continue
    }
    if (blockComment) continue

    const commentIndex = findUnquotedCharacter(line, '#')
    const code = commentIndex < 0 ? line : line.slice(0, commentIndex)
    const dependency = code.match(/^\s*gem\s*(?:\(\s*)?["']([^"']+)["']/)?.[1]
    if (dependency !== undefined) addTerm(into, dependency)

    heredocs.push(...findRubyHeredocs(code))
  }
}

const readManifestTerms = async (repositoryRoot: string, into: Set<string>): Promise<void> => {
  const readers: ReadonlyArray<(terms: Set<string>, priorityTerms: Set<string>) => Promise<void>> = [
    (terms, priorityTerms) => readJsonManifestTerms(
      repositoryRoot,
      'package.json',
      ['dependencies', 'devDependencies'],
      terms,
      priorityTerms,
    ),
    (terms, priorityTerms) => readPyprojectTerms(repositoryRoot, terms, priorityTerms),
    (terms, priorityTerms) => readGoModTerms(repositoryRoot, terms, priorityTerms),
    (terms, priorityTerms) => readCargoTerms(repositoryRoot, terms, priorityTerms),
    (terms, priorityTerms) => readCsprojTerms(repositoryRoot, terms, priorityTerms),
    (terms, priorityTerms) => readJsonManifestTerms(
      repositoryRoot,
      'composer.json',
      ['require', 'require-dev'],
      terms,
      priorityTerms,
    ),
    (terms) => readGemfileTerms(repositoryRoot, terms),
  ]

  for (const readTerms of readers) {
    const terms = new Set<string>()
    const priorityTerms = new Set<string>()
    await readTerms(terms, priorityTerms)

    let addedTerms = 0
    for (const sourceTerms of [priorityTerms, terms]) {
      for (const term of sourceTerms) {
        if (
          into.size >= MAXIMUM_VOCABULARY_TERMS
          || addedTerms >= MAXIMUM_TERMS_PER_MANIFEST_SOURCE
        ) break
        if (into.has(term)) continue
        into.add(term)
        addedTerms += 1
      }
    }
  }
}

export const collectProjectVocabulary = async (
  repositoryRoot: string,
  projectTerms: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const vocabulary = new Set<string>()

  for (const term of projectTerms) addTerm(vocabulary, term, true)
  await readManifestTerms(repositoryRoot, vocabulary)

  try {
    const entries = await readdir(repositoryRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (vocabulary.size >= MAXIMUM_VOCABULARY_TERMS) break
      if (IGNORED_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue
      if (!entry.isDirectory()) {
        if (ROOT_SOURCE_PATTERN.test(entry.name)) {
          const stem = foldDiacritics(entry.name.replace(/\.[^.]+$/, '')).trim()
          if (
            stem.length >= MINIMUM_TERM_LENGTH
            && stem.length <= MAXIMUM_TERM_LENGTH
            && SEPARATOR_PATTERN.test(stem)
          ) {
            vocabulary.add(stem)
          }
        }
        continue
      }

      addTerm(vocabulary, entry.name)
      const children = await readdir(join(repositoryRoot, entry.name), { withFileTypes: true })
      for (const child of children) {
        if (vocabulary.size >= MAXIMUM_VOCABULARY_TERMS) break
        if (IGNORED_ENTRIES.has(child.name) || child.name.startsWith('.')) continue
        addTerm(vocabulary, child.name.replace(/\.[a-z0-9]+$/i, ''))
      }
    }
  } catch {
    // an unreadable directory just yields a smaller vocabulary
  }

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
    if (!SEPARATOR_PATTERN.test(term)) continue

    const parts = term.split(SEPARATOR_PATTERN).filter((part) => part.length > 0)
    if (parts.length > 1 && containsTermSequence(tokens, parts)) return true
  }
  return false
}
