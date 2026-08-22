import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncFailure, err, ok, type Result } from './core.ts'

export const DENY_LIST_FILENAME = '.pieces-to-agents-ignore'

const REDACTED = '[redacted]'

const PLACEHOLDER_LABELS = [
  'redacted',
  'email',
  'jwt',
  'github-token',
  'slack-token',
  'aws-key',
  'api-key',
  'url-with-credentials',
  'phone',
  'local path',
] as const

const ORPHAN_BRACKET_PATTERN = new RegExp(
  `\\[(?!(?:${PLACEHOLDER_LABELS.join('|')})\\])([^\\]]+)\\](?![(:])`,
  'g',
)

const PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/`(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^`\n]+`/gi, '`[local path]`'],
  [/"(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^"\n]+"/gi, '"[local path]"'],
  [/'(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^'\n]+'/gi, "'[local path]'"],
  [/\[(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^\]\n]+\]/gi, '[local path]'],
  [/\((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^)\n]+\)/gi, '([local path])'],
  [/<(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^>\n]+>/gi, '<[local path]>'],
  [/\{(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/\/[^/.\n]+\/|\/(?!\/))[^}\n]+\}/gi, '{[local path]}'],
  [/(^|[^A-Za-z0-9+.-])file:\/\/[^\n]+/gim, '$1[local path]'],
  [/\b[A-Za-z]:[\\/][^\n]+/g, '[local path]'],
  [/\\\\(?:\?\\)?[^\n]+/g, '[local path]'],
  [/(^|[^A-Za-z0-9/.:])\/\/[^/.\s]+\/[^\n]+/gm, '$1[local path]'],
  [/(^|[^A-Za-z0-9/.])\/(?!\/|>)[^\n]+/gm, '$1[local path]'],
]

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s/@:]+(?::[^\s/@]*)?|:[^\s/@]+)@[^\s"'`<>()\]]+/g, '[url-with-credentials]'],
  [/(^|[^A-Za-z0-9+.-:])\/\/(?:[^\s/@:]+(?::[^\s/@]*)?|:[^\s/@]+)@[^\s"'`<>()\]]+/gm, '$1[url-with-credentials]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, '[email]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{20,}/gi, '[api-key]'],
  [/\[([^\]]+)\]\(\s*pieces:\/\/[^)]*\)/gi, '$1'],
  [/\(pieces:\/\/[^)\s]+\)/gi, ''],
  [/pieces:\/\/\S+/gi, ''],
  [/\+\d[\d  ().-]{7,}\d/g, '[phone]'],
  [/\(\d{2,3}\)\s?\d{4,5}[- ]?\d{4}/g, '[phone]'],
]

const PRESERVED_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\]\(\s*<?\/{1,2}(?!\/)[^)\n]*>?\)/g,
  /^\s*!?\[[^\]\n]+\]:\s*<?\/{1,2}(?!\/)[^\n]*$/gm,
  /\b(?:action|formaction|href|poster|src)\s*=\s*(["'])\/{1,2}(?!\/)[^\n]*?\1/gi,
  /<\/[A-Za-z][A-Za-z0-9:-]*\s*>/g,
]

const PRESERVED_CONTEXT_MARKER_PATTERN = /\u0000preserved-context-(\d+)\u0000/g

const MALFORMED_LINK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\[`?\[(?:local path|phone|email)\]`?\]\([^)]*\)?/g, '[redacted]'],
  [/\[([^\]]+)\]\(\s*`?\[(?:local path|phone|email)\]`?[^)]*\)?/g, '$1'],
  [/\[([^\]]+)\]\([^)\s]*$/g, '$1'],
  [ORPHAN_BRACKET_PATTERN, '$1'],
]

const escapeForRegex = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const redact = (text: string, deniedTerms: ReadonlyArray<string> = []): string => {
  let output = text

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }

  for (const term of deniedTerms) {
    const trimmed = term.trim()
    if (trimmed.length === 0) continue
    output = output.replace(new RegExp(escapeForRegex(trimmed), 'gi'), REDACTED)
  }

  const preservedContexts: string[] = []
  for (const pattern of PRESERVED_CONTEXT_PATTERNS) {
    output = output.replace(pattern, (match: string): string => {
      const marker = `\u0000preserved-context-${preservedContexts.length}\u0000`
      preservedContexts.push(match)
      return marker
    })
  }

  for (const [pattern, replacement] of PATH_PATTERNS) {
    output = output.replace(pattern, replacement)
  }

  output = output.replace(
    PRESERVED_CONTEXT_MARKER_PATTERN,
    (_match: string, index: string): string => preservedContexts[Number(index)] ?? '',
  )

  for (const [pattern, replacement] of MALFORMED_LINK_PATTERNS) {
    output = output.replace(pattern, replacement)
  }

  return output
}

export const loadDenyList = async (
  repositoryRoot: string,
): Promise<Result<ReadonlyArray<string>, SyncFailure>> => {
  try {
    const raw = await readFile(join(repositoryRoot, DENY_LIST_FILENAME), 'utf8')
    return ok(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#')),
    )
  } catch (caught) {
    if (isMissingFile(caught)) return ok([])
    return err(SyncFailure.DenyListReadFailed)
  }
}

const isMissingFile = (caught: unknown): boolean =>
  typeof caught === 'object' &&
  caught !== null &&
  'code' in caught &&
  (caught as { code?: unknown }).code === 'ENOENT'
