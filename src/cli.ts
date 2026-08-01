#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { diffLines } from 'diff'
import {
  DEFAULT_WINDOW_DAYS,
  MILLISECONDS_PER_DAY,
  SyncFailure,
  TargetFile,
  err,
  ok,
  type Result,
} from './core.ts'
import { McpClient } from './mcp.ts'
import { collectMemories } from './memory.ts'
import { composeBlock, readTarget, spliceManagedBlock, writeTarget } from './agents-file.ts'
import { DENY_LIST_FILENAME, loadDenyList } from './redact.ts'

const RESET = '[0m'
const RED = '[31m'
const GREEN = '[32m'
const DIM = '[2m'
const BOLD = '[1m'

const FAILURE_MESSAGES: Readonly<Record<SyncFailure, string>> = {
  [SyncFailure.NotAGitRepository]:
    'No git repository found from the current directory upward. Run this inside a repository.',
  [SyncFailure.PiecesOsUnreachable]:
    'PiecesOS is not reachable on localhost:39300. Start PiecesOS and try again.',
  [SyncFailure.McpHandshakeFailed]:
    'PiecesOS answered but rejected the MCP handshake. Check that the MCP server is enabled in Pieces settings.',
  [SyncFailure.McpCallFailed]: 'A call to the Pieces MCP server failed.',
  [SyncFailure.NoMemoriesInWindow]:
    'No memories found in the selected window. Try a longer window with --days.',
  [SyncFailure.NoProjectMatch]:
    'Memories were found, but none mention this project. Pass --alias with a name that appears in your work, or use --project.',
  [SyncFailure.ManagedBlockConflict]:
    'The target file has a malformed pieces-to-agents block. Fix the start/end markers manually.',
  [SyncFailure.ReadFailed]: 'Could not read the target file.',
  [SyncFailure.WriteFailed]: 'Could not write the target file.',
  [SyncFailure.Cancelled]: 'Cancelled. Nothing was written.',
}

const EXIT_CODES: Readonly<Record<SyncFailure, number>> = {
  [SyncFailure.NotAGitRepository]: 2,
  [SyncFailure.PiecesOsUnreachable]: 3,
  [SyncFailure.McpHandshakeFailed]: 4,
  [SyncFailure.McpCallFailed]: 5,
  [SyncFailure.NoMemoriesInWindow]: 6,
  [SyncFailure.NoProjectMatch]: 6,
  [SyncFailure.ManagedBlockConflict]: 7,
  [SyncFailure.ReadFailed]: 8,
  [SyncFailure.WriteFailed]: 9,
  [SyncFailure.Cancelled]: 0,
}

const findRepositoryRoot = async (startingPath: string): Promise<Result<string, SyncFailure>> => {
  let current = resolve(startingPath)

  for (;;) {
    try {
      const candidate = await stat(join(current, '.git'))
      if (candidate.isDirectory() || candidate.isFile()) return ok(current)
    } catch {
      // walk up
    }

    const parent = dirname(current)
    if (parent === current) return err(SyncFailure.NotAGitRepository)
    current = parent
  }
}

const printDiff = (before: string, after: string): void => {
  for (const part of diffLines(before, after)) {
    const marker = part.added ? '+' : part.removed ? '-' : ' '
    const color = part.added ? GREEN : part.removed ? RED : DIM
    if (!part.added && !part.removed) continue

    for (const line of part.value.replace(/\n$/, '').split('\n')) {
      process.stdout.write(`${color}${marker} ${line}${RESET}\n`)
    }
  }
}

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(question)
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

const run = async (): Promise<Result<string, SyncFailure>> => {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: TargetFile.Agents },
      days: { type: 'string', default: String(DEFAULT_WINDOW_DAYS) },
      project: { type: 'string' },
      alias: { type: 'string', multiple: true, default: [] },
    },
    allowPositionals: true,
  })

  const repositoryRoot = await findRepositoryRoot(process.cwd())
  if (!repositoryRoot.ok) return repositoryRoot

  const parsedDays = Number.parseInt(values.days ?? '', 10)
  const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : DEFAULT_WINDOW_DAYS
  const project = values.project ?? basename(repositoryRoot.value)
  const targetName = values.target === TargetFile.Claude ? TargetFile.Claude : TargetFile.Agents
  const targetPath = join(repositoryRoot.value, targetName)

  process.stdout.write(
    `${BOLD}pieces-to-agents${RESET} ${DIM}project "${project}", last ${windowDays} days → ${targetName}${RESET}\n\n`,
  )

  const connection = await McpClient.connect()
  if (!connection.ok) return connection

  const deniedTerms = await loadDenyList(repositoryRoot.value)
  if (deniedTerms.length > 0) {
    process.stdout.write(`${DIM}Redacting ${deniedTerms.length} term(s) from ${DENY_LIST_FILENAME}${RESET}\n`)
  }

  const since = new Date(Date.now() - windowDays * MILLISECONDS_PER_DAY)
  const memories = await collectMemories(connection.value, {
    project,
    aliases: values.alias ?? [],
    since,
    deniedTerms,
  })
  if (!memories.ok) return memories

  const block = composeBlock(memories.value, {
    project,
    windowDays,
    generatedAt: new Date().toISOString().slice(0, 10),
  })

  const existing = await readTarget(targetPath)
  if (!existing.ok) return existing

  const updated = spliceManagedBlock(existing.value, block)
  if (!updated.ok) return updated

  if (updated.value === existing.value) return ok(`${targetName} is already up to date.`)

  process.stdout.write(`${BOLD}Proposed changes to ${targetName}:${RESET}\n\n`)
  printDiff(existing.value, updated.value)

  process.stdout.write(
    `\n${BOLD}Review carefully.${RESET} Memory can contain names, employers and private notes.\n`,
  )
  process.stdout.write(`${DIM}Add terms to ${DENY_LIST_FILENAME} to redact them permanently.${RESET}\n\n`)

  const approved = await confirm(`Write ${memories.value.length} memories to ${targetName}? [y/N] `)
  if (!approved) return err(SyncFailure.Cancelled)

  const written = await writeTarget(targetPath, updated.value)
  if (!written.ok) return written

  return ok(`Wrote ${targetName} with ${memories.value.length} memories.`)
}

const outcome = await run()

if (outcome.ok) {
  process.stdout.write(`${GREEN}${outcome.value}${RESET}\n`)
} else {
  process.stdout.write(`\n${RED}${FAILURE_MESSAGES[outcome.error]}${RESET}\n`)
  process.exitCode = EXIT_CODES[outcome.error]
}
