import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DENY_LIST_FILENAME = '.pieces-to-agents-ignore'

const REDACTED = '[redacted]'

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, '[email]'],
  [/file:\/\/\/\S+/gi, '[local path]'],
  [/\b[A-Za-z]:[\\/](?:[^\\/\n"'`)\]]*[\\/])*[^\s"'`)\]]*/g, '[local path]'],
  [/(?:^|\s)\/(?:home|Users|mnt|srv)\/(?:[^/\n"'`)\]]*\/)*[^\s"'`)\]]*/g, ' [local path]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{20,}/gi, '[api-key]'],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/g, '[url-with-credentials]'],
  [/\(pieces:\/\/[^)\s]+\)/gi, ''],
  [/pieces:\/\/\S+/gi, ''],
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

  return output
}

export const loadDenyList = async (repositoryRoot: string): Promise<ReadonlyArray<string>> => {
  try {
    const raw = await readFile(join(repositoryRoot, DENY_LIST_FILENAME), 'utf8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}
