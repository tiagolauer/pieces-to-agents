import { readFile } from 'node:fs/promises'

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const foldDiacritics = (value: string): string =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

export enum MemoryCategory {
  ArchitectureDecisions = 'architecture-decisions',
  ResolvedBugs = 'resolved-bugs',
  Conventions = 'conventions',
  EnvironmentGotchas = 'environment-gotchas',
}

export enum AnnotationType {
  Summary = 'SUMMARY',
  Description = 'DESCRIPTION',
  HierarchicalProfileSummary = 'HIERARCHICAL_PROFILE_SUMMARY',
}

export enum TargetFile {
  Agents = 'AGENTS.md',
  Claude = 'CLAUDE.md',
}

export const resolveTargetFile = (requested: string): TargetFile | null => {
  const normalized = requested.trim().toLowerCase().replace(/\.md$/, '')

  if (normalized === 'agents') return TargetFile.Agents
  if (normalized === 'claude') return TargetFile.Claude
  return null
}

export enum SyncFailure {
  NotAGitRepository = 'not-a-git-repository',
  PiecesOsUnreachable = 'pieces-os-unreachable',
  McpHandshakeFailed = 'mcp-handshake-failed',
  McpCallFailed = 'mcp-call-failed',
  McpTimeout = 'mcp-timeout',
  NoMemoriesInWindow = 'no-memories-in-window',
  NoProjectMatch = 'no-project-match',
  UnknownTarget = 'unknown-target',
  UnknownOption = 'unknown-option',
  ManagedBlockConflict = 'managed-block-conflict',
  ReadFailed = 'read-failed',
  WriteFailed = 'write-failed',
  Cancelled = 'cancelled',
}

export const ALLOWED_ANNOTATION_TYPES: ReadonlySet<AnnotationType> = new Set([
  AnnotationType.Summary,
  AnnotationType.Description,
])

export const CATEGORY_TITLES: Readonly<Record<MemoryCategory, string>> = {
  [MemoryCategory.ArchitectureDecisions]: 'Architecture decisions',
  [MemoryCategory.ResolvedBugs]: 'Resolved bugs and root causes',
  [MemoryCategory.Conventions]: 'Conventions and patterns',
  [MemoryCategory.EnvironmentGotchas]: 'Environment gotchas',
}

export const CATEGORY_QUERIES: Readonly<Record<MemoryCategory, string>> = {
  [MemoryCategory.ArchitectureDecisions]:
    'architecture decisions, technical trade-offs, and the reasoning behind technology choices',
  [MemoryCategory.ResolvedBugs]:
    'bugs that were debugged and fixed, their root cause and the solution applied',
  [MemoryCategory.Conventions]:
    'coding conventions, naming patterns, project structure and style rules adopted',
  [MemoryCategory.EnvironmentGotchas]:
    'setup steps, environment configuration, build tooling problems and their workarounds',
}

export const CATEGORY_KEYWORDS: Readonly<Record<MemoryCategory, string>> = {
  [MemoryCategory.ArchitectureDecisions]: 'architecture',
  [MemoryCategory.ResolvedBugs]: 'bug',
  [MemoryCategory.Conventions]: 'convention',
  [MemoryCategory.EnvironmentGotchas]: 'setup',
}

export const FULL_TEXT_SCORE = 0

export const MCP_ENDPOINT = 'http://localhost:39300/model_context_protocol/2025-03-26/mcp'
export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const CLIENT_NAME = 'pieces-to-agents'

const FALLBACK_VERSION = '0.0.0'

const readOwnVersion = async (): Promise<string> => {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const manifest: unknown = JSON.parse(raw)
    if (typeof manifest !== 'object' || manifest === null) return FALLBACK_VERSION
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' ? version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

export const CLIENT_VERSION = await readOwnVersion()

export const MARKER_START = '<!-- pieces-to-agents:start -->'
export const MARKER_END = '<!-- pieces-to-agents:end -->'

export const DEFAULT_WINDOW_DAYS = 14
export const DEFAULT_SEARCH_LIMIT = 8
export const SIMILARITY_THRESHOLD = 0.35
export const CALL_TIMEOUT_MS = 30_000
export const MILLISECONDS_PER_DAY = 86_400_000
