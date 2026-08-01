export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

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

export enum SyncFailure {
  NotAGitRepository = 'not-a-git-repository',
  PiecesOsUnreachable = 'pieces-os-unreachable',
  McpHandshakeFailed = 'mcp-handshake-failed',
  McpCallFailed = 'mcp-call-failed',
  NoMemoriesInWindow = 'no-memories-in-window',
  NoProjectMatch = 'no-project-match',
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

export const FULL_TEXT_SCORE = 1

export const MCP_ENDPOINT = 'http://localhost:39300/model_context_protocol/2025-03-26/mcp'
export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const CLIENT_NAME = 'pieces-to-agents'
export const CLIENT_VERSION = '0.1.3'

export const MARKER_START = '<!-- pieces-to-agents:start -->'
export const MARKER_END = '<!-- pieces-to-agents:end -->'

export const DEFAULT_WINDOW_DAYS = 14
export const DEFAULT_SEARCH_LIMIT = 8
export const SIMILARITY_THRESHOLD = 0.35
export const CALL_TIMEOUT_MS = 30_000
export const MILLISECONDS_PER_DAY = 86_400_000
