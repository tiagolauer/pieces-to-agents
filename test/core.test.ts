import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { composeBlock, spliceManagedBlock, trimTitleToProject } from '../src/agents-file.ts'
import {
  CLIENT_VERSION,
  DEFAULT_WINDOW_DAYS,
  MARKER_END,
  MARKER_START,
  MemoryCategory,
  SyncFailure,
  TargetFile,
  resolveTargetFile,
  resolveWindowDays,
} from '../src/core.ts'
import {
  categoryFromKeywords,
  collectMemories,
  isAboutProject,
  searchLimitForWindow,
  type MemoryEntry,
} from '../src/memory.ts'
import { detectCandidateEntities } from '../src/entities.ts'
import { McpClient, parseEventStreamMessage } from '../src/mcp.ts'
import { DENY_LIST_FILENAME, loadDenyList, redact } from '../src/redact.ts'
import { collectProjectVocabulary, isAnchoredToProject } from '../src/vocabulary.ts'

const VOCABULARY: ReadonlySet<string> = new Set([
  'demo',
  'postgresql',
  'mongodb',
  'graphql',
  'parser',
])

const CLI_PROCESS_TIMEOUT_MS = 10_000

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  category: MemoryCategory.ArchitectureDecisions,
  title: 'Session title',
  createdAt: '2026-07-30T10:00:00.000Z',
  text: '### Decisions\n- Chose PostgreSQL over MongoDB for relational integrity\n- Rejected GraphQL to keep the surface small',
  ...overrides,
})

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

type ProcessResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const runCli = async (
  repositoryRoot: string,
  preloadPath: string,
  answer: string,
): Promise<ProcessResult> => {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preloadPath).href, cliPath],
    {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_PROCESS_TIMEOUT_MS,
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  child.stdin.end(answer)

  return await new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('spliceManagedBlock appends the block and preserves handwritten content', () => {
  const existing = '# My Project\n\nHandwritten notes.\n'
  const result = spliceManagedBlock(existing, `${MARKER_START}\nGENERATED\n${MARKER_END}`)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.value, /# My Project/)
  assert.match(result.value, /Handwritten notes\./)
  assert.match(result.value, /GENERATED/)
})

test('spliceManagedBlock replaces only the managed region', () => {
  const existing = `# Title\n\nBefore.\n\n${MARKER_START}\nOLD\n${MARKER_END}\n\nAfter.\n`
  const result = spliceManagedBlock(existing, `${MARKER_START}\nNEW\n${MARKER_END}`)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.value, /Before\./)
  assert.match(result.value, /After\./)
  assert.match(result.value, /NEW/)
  assert.doesNotMatch(result.value, /OLD/)
})

test('spliceManagedBlock refuses to write when markers are malformed', () => {
  const existing = `# Title\n\n${MARKER_START}\nOrphaned start marker.\n`
  const result = spliceManagedBlock(existing, `${MARKER_START}\nNEW\n${MARKER_END}`)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, SyncFailure.ManagedBlockConflict)
})

test('redact removes emails and secret tokens', () => {
  const scrubbed = redact('Contact me at dev@example.com using ghp_abcdefghijklmnopqrstuvwxyz01')

  assert.doesNotMatch(scrubbed, /dev@example\.com/)
  assert.doesNotMatch(scrubbed, /ghp_abcdefghijklmnopqrstuvwxyz01/)
  assert.match(scrubbed, /\[email\]/)
  assert.match(scrubbed, /\[github-token\]/)
})

test('redact leaves a package version alone', () => {
  const scrubbed = redact('Deprecated pieces-to-agents@0.1.0 after the scoping bug')

  assert.match(scrubbed, /pieces-to-agents@0\.1\.0/)
  assert.doesNotMatch(scrubbed, /\[email\]/)
})

test('redact removes absolute paths from any platform', () => {
  const windows = redact('Edited F:\\Fontes\\Clientes\\secret-app\\src\\core.ts today')
  const unix = redact('Edited /home/developer/clients/secret-app/src/core.ts today')
  const fileUri = redact('Opened file:///F:/Fontes/Clientes/secret-app/package.json')

  for (const scrubbed of [windows, unix, fileUri]) {
    assert.doesNotMatch(scrubbed, /secret-app/)
    assert.match(scrubbed, /\[local path\]/)
  }
})

test('redact removes POSIX paths outside home and Windows UNC paths', () => {
  const posix = redact('Edited /opt/clients/private-project/parser.ts today')
  const inlineCode = redact('Edited `/opt/clients/private-project/parser.ts` today')
  const quoted = redact('Opened "/opt/clients/private-project/parser.ts" today')
  const bracketed = redact('Opened [/opt/clients/private-project/parser.ts] today')
  const assigned = redact('Used --config=/home/user/private-project.json today')
  const environment = redact('Set OUTPUT=/opt/clients/private-project/parser.ts today')
  const singleSegment = redact('Opened /private-project today')
  const spacedPosix = redact('Opened "/opt/clients/private-project/secret file.txt" today')
  const spacedWindows = redact('Opened "C:\\clients\\private-project\\secret file.txt" today')
  const parenthesized = redact('Opened (/opt/clients/private-project/secret file.txt) today')
  const angled = redact('Opened <file://corp-server/clients/private-project/secret file.txt> today')
  const unquotedSpacedPosix = redact('Opened /opt/clients/private-project/secret file.txt today')
  const unquotedSpacedWindows = redact('Opened C:\\clients\\private-project\\secret file.txt today')
  const unquotedNoExtension = redact('Opened /opt/clients/private-project/Secret Client')
  const unquotedPeriod = redact('Opened C:\\clients\\private-project\\secret file.txt.')
  const bracketedSegment = redact('Opened C:\\clients\\[private-project]\\app.ts today')
  const unc = redact('Edited \\\\corp-server\\clients\\private-project\\parser.ts today')
  const extendedUnc = redact('Edited \\\\?\\UNC\\corp-server\\clients\\private-project\\parser.ts today')
  const forwardUnc = redact('Edited //corp-server/clients/private-project/parser.ts today')
  const networkFileUri = redact('Opened file://corp-server/clients/private-project/parser.ts today')

  for (const scrubbed of [
    posix,
    inlineCode,
    quoted,
    bracketed,
    assigned,
    environment,
    singleSegment,
    spacedPosix,
    spacedWindows,
    parenthesized,
    angled,
    unquotedSpacedPosix,
    unquotedSpacedWindows,
    unquotedNoExtension,
    unquotedPeriod,
    bracketedSegment,
    unc,
    extendedUnc,
    forwardUnc,
    networkFileUri,
  ]) {
    assert.doesNotMatch(scrubbed, /private-project/)
    assert.match(scrubbed, /\[local path\]/)
  }

  assert.match(quoted, /today/)
  assert.match(spacedPosix, /today/)
  assert.equal(redact('Read https://example.com/private-project/docs'), 'Read https://example.com/private-project/docs')
  assert.equal(redact('Read //cdn.example.com/assets/app.js'), 'Read //cdn.example.com/assets/app.js')
  assert.equal(redact('Read [app](//cdn.example.com/assets/app.js) today'), 'Read [app](//cdn.example.com/assets/app.js) today')
  assert.equal(redact('Read [guide](/docs/setup) today'), 'Read [guide](/docs/setup) today')
  assert.equal(redact('Read [guide](</docs/getting started>) today'), 'Read [guide](</docs/getting started>) today')
  assert.equal(redact('[guide]: /docs/setup'), '[guide]: /docs/setup')
  assert.equal(redact('![logo]: /assets/logo.svg'), '![logo]: /assets/logo.svg')
  assert.equal(redact('Set href="/docs/setup" in the parser'), 'Set href="/docs/setup" in the parser')
  assert.equal(redact("Set src = '/assets/app.js' in the parser"), "Set src = '/assets/app.js' in the parser")
  assert.doesNotMatch(redact('Set href="C:\\clients\\private-project\\app.ts"'), /private-project/)
  assert.equal(redact('<a href="/docs">Docs</a>'), '<a href="/docs">Docs</a>')
  assert.equal(redact('<img src="/assets/logo.svg" />'), '<img src="/assets/logo.svg" />')
  assert.equal(redact('Closed </div> after rendering'), 'Closed </div> after rendering')
  assert.doesNotMatch(redact('[admin](//alice:!#$%@example.com/private)'), /alice|!#\$%/)
  assert.doesNotMatch(redact('[admin](//alice:supersecret@example.com/private)'), /alice|supersecret/)
  assert.equal(
    redact('<a href="//alice:supersecret@example.com/private">admin</a>'),
    '<a href="[url-with-credentials]">admin</a>',
  )
  for (const credentialUrl of [
    '[admin](//git@localhost/private)',
    '[admin](//alice:@example.com/private)',
    '[admin](https://git@localhost/private)',
    '[admin](//:!#$%@example.com/private)',
    '[admin](https://:!#$%@example.com/private)',
  ]) {
    assert.doesNotMatch(redact(credentialUrl), /alice|git@|!#\$%/)
  }
  assert.equal(redact('Opened profile://example.com/private'), 'Opened profile://example.com/private')
  assert.equal(redact('Edited ./private-project/parser.ts'), 'Edited ./private-project/parser.ts')
})

test('redact removes phone numbers', () => {
  const international = redact('Outreach from a founder (+1 202 555 0100) about a role')
  const brazilian = redact('Called (11) 98765-4321 to confirm')

  assert.doesNotMatch(international, /202 555 0100/)
  assert.doesNotMatch(brazilian, /98765-4321/)
  assert.match(international, /\[phone\]/)
  assert.match(brazilian, /\[phone\]/)
})

test('redact does not leave broken markdown when a link target is scrubbed', () => {
  const scrubbed = redact('Refactored in [`F:\\work\\app\\src\\core.ts`](file:///F:/work/app/src/core.ts) today')

  assert.doesNotMatch(scrubbed, /\]\(/)
  assert.doesNotMatch(scrubbed, /core\.ts/)
})

test('redact collapses an internal Pieces link to its text', () => {
  const scrubbed = redact('Handled [TypeScript](pieces://assets/abc123) 7.0 API changes')

  assert.equal(scrubbed, 'Handled TypeScript 7.0 API changes')
})

test('redact keeps its own placeholders intact', () => {
  const scrubbed = redact('Mailed dev@example.com and wrote to F:\\work\\app\\core.ts')

  assert.match(scrubbed, /\[local path\]/)
  assert.match(scrubbed, /\[email\]/)
})

test('redact removes a path whose folders contain spaces', () => {
  const scrubbed = redact('Refactored F:\\Fontes\\Client Work\\secret-app\\src\\core.ts')

  assert.doesNotMatch(scrubbed, /secret-app/)
  assert.doesNotMatch(scrubbed, /Client Work/)
  assert.doesNotMatch(scrubbed, /core\.ts/)
})

test('redact removes denied terms regardless of case', () => {
  const scrubbed = redact('Reviewed with Jane Doe at AcmeCorp', ['jane doe', 'AcmeCorp'])

  assert.doesNotMatch(scrubbed, /Jane Doe/i)
  assert.doesNotMatch(scrubbed, /AcmeCorp/i)
})

test('loadDenyList allows a missing file but rejects one it cannot read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-deny-list-'))

  const missing = await loadDenyList(root)
  assert.deepEqual(missing, { ok: true, value: [] })

  await mkdir(join(root, DENY_LIST_FILENAME))
  const unreadable = await loadDenyList(root)
  assert.deepEqual(unreadable, { ok: false, error: SyncFailure.DenyListReadFailed })
})

test('composeBlock emits bullets under the category heading', () => {
  const block = composeBlock(
    [entry()],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /^<!-- pieces-to-agents:start -->/)
  assert.match(block, /Architecture decisions/)
  assert.match(block, /- Chose PostgreSQL over MongoDB/)
  assert.match(block, /2026-07-30/)
  assert.equal(block.trimEnd().endsWith(MARKER_END), true)
})

test('composeBlock skips entries that carry no bullet content', () => {
  const block = composeBlock(
    [entry({ text: 'Prose only, no bullet list here.' })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.doesNotMatch(block, /Architecture decisions/)
})

test('isAboutProject keeps sessions whose title names the project or an alias', () => {
  assert.equal(isAboutProject('Refactored the Pieces-To-Agents CLI', ['pieces-to-agents']), true)
  assert.equal(isAboutProject('Debugged the ptha extractor', ['pieces-to-agents', 'ptha']), true)
})

test('isAboutProject does not match a short name buried inside a word', () => {
  assert.equal(isAboutProject('Rapid prototyping session', ['api']), false)
  assert.equal(isAboutProject('Scanning the docs', ['can']), false)
  assert.equal(isAboutProject('A word about hardware', ['war']), false)
})

test('isAboutProject still matches a short name standing on its own', () => {
  assert.equal(isAboutProject('Reworked the api layer', ['api']), true)
  assert.equal(isAboutProject('api-gateway cleanup', ['api']), true)
})

test('spliceManagedBlock refuses a file carrying two managed blocks', () => {
  const existing =
    `${MARKER_START}\nFIRST\n${MARKER_END}\n\n${MARKER_START}\nSECOND\n${MARKER_END}\n`
  const result = spliceManagedBlock(existing, `${MARKER_START}\nNEW\n${MARKER_END}`)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, SyncFailure.ManagedBlockConflict)
})

test('isAboutProject rejects sessions titled after other work', () => {
  assert.equal(isAboutProject('Senior C# Prep and Architecture', ['pieces-to-agents']), false)
})

test('isAboutProject matches across accents, spacing and separators', () => {
  assert.equal(isAboutProject('Marcô Agenda Rebrand and Refactor', ['marco-agenda']), true)
  assert.equal(isAboutProject('Marco Agenda Rebrand', ['marco_agenda']), true)
  assert.equal(isAboutProject('OwlSQL Audit', ['owl sql']), true)
})

test('isAboutProject does not match a long name buried inside a longer word', () => {
  assert.equal(isAboutProject('Marconi Radio Session', ['marco']), false)
  assert.equal(isAboutProject('Legacy Marcosystems Migration', ['marco']), false)
  assert.equal(isAboutProject('Marco Agenda Rebrand', ['marco']), true)
})

test('isAboutProject ignores a passing mention in the session body', () => {
  const title = 'KangoOS PR and Contract Negotiation'
  const body =
    'Reviewed the Vercel project list including marco-agenda, dori-finance and the portfolio. ' +
    'Negotiated contract terms with a recruiter and set up 2FA recovery codes.'

  assert.equal(isAboutProject(title, ['marco-agenda']), false)
  assert.equal(isAboutProject(`${title}\n${body}`, ['marco-agenda']), true)
})

test('searchLimitForWindow asks for more the further back you look', () => {
  assert.equal(searchLimitForWindow(14), 8)
  assert.equal(searchLimitForWindow(7), 8)
  assert.equal(searchLimitForWindow(90), 56)
  assert.equal(searchLimitForWindow(365), 100)
  assert.equal(searchLimitForWindow(10_000), 100)
})

test('collectMemories searches aliases as well as the primary project name', async () => {
  const queries: string[] = []
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as {
      id?: string
      method?: string
      params?: { name?: string; arguments?: { query?: string } }
    }

    response.setHeader('Content-Type', 'application/json')
    if (body.method === 'notifications/initialized') {
      response.statusCode = 202
      response.end()
      return
    }

    let payload: unknown = {}
    if (body.method === 'tools/call') {
      const tool = body.params?.name
      const query = body.params?.arguments?.query ?? ''
      if (query.length > 0) queries.push(query)

      if (tool === 'workstream_summaries_vector_search') payload = { results: [] }
      if (tool === 'workstream_summaries_full_text_search') {
        payload = query.includes('ptha')
          ? { results: [{ summary: { id: 'summary-1' } }] }
          : { results: [] }
      }
      if (tool === 'workstream_summaries_batch_snapshot') {
        payload = {
          items: [{
            id: 'summary-1',
            name: 'PTHA parser refactor',
            created: { value: '2026-08-11T10:00:00.000Z' },
            annotations: { indices: { 'annotation-1': {} } },
          }],
        }
      }
      if (tool === 'annotations_batch_snapshot') {
        payload = {
          items: [{ id: 'annotation-1', type: 'SUMMARY', text: '- Rewrote the PTHA parser' }],
        }
      }
    }

    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: body.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify(payload) }] }
        : {},
    }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const connected = await McpClient.connect(`http://127.0.0.1:${port}`)
    assert.equal(connected.ok, true)
    if (!connected.ok) return

    const result = await collectMemories(connected.value, {
      project: 'pieces-to-agents',
      aliases: ['ptha'],
      since: new Date(0),
      windowDays: 14,
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value[0]?.title, 'PTHA parser refactor')
    assert.equal(queries.some((query) => query.includes('ptha')), true)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('McpClient maps a truncated handshake body to a Result failure', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.flushHeaders()
    response.write('{"jsonrpc":"2.0"')
    setTimeout(() => response.destroy(), 10)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const result = await McpClient.connect(`http://127.0.0.1:${port}`)

    assert.deepEqual(result, { ok: false, error: SyncFailure.McpHandshakeFailed })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('McpClient rejects a JSON response with another request id', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 'stale', result: {} }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const result = await McpClient.connect(`http://127.0.0.1:${port}`)

    assert.deepEqual(result, { ok: false, error: SyncFailure.McpHandshakeFailed })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('McpClient rejects an SSE response without a result or error', async () => {
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as { id?: string }
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id })}\n\n`)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const result = await McpClient.connect(`http://127.0.0.1:${port}`)

    assert.deepEqual(result, { ok: false, error: SyncFailure.McpHandshakeFailed })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('McpClient rejects invalid JSON-RPC envelopes', async () => {
  const invalidResponses = [
    { jsonrpc: '2.0', result: 'invalid', error: null },
    { jsonrpc: '2.0', result: [] },
    { jsonrpc: '2.0', error: null },
    { jsonrpc: '2.0', result: {}, error: 'invalid' },
    { jsonrpc: '1.0', result: {} },
  ]

  for (const invalid of invalidResponses) {
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request)) as { id?: string }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ...invalid, id: body.id }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const result = await McpClient.connect(`http://127.0.0.1:${port}`)

      assert.deepEqual(result, { ok: false, error: SyncFailure.McpHandshakeFailed })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  }
})

test('McpClient rejects a tool result marked as an error', async () => {
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readRequestBody(request)) as { id?: string; method?: string }
    if (body.method === 'notifications/initialized') {
      response.statusCode = 202
      response.end()
      return
    }

    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: body.method === 'tools/call'
        ? { isError: true, content: [{ type: 'text', text: 'database unavailable' }] }
        : {},
    }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const connected = await McpClient.connect(`http://127.0.0.1:${port}`)
    assert.equal(connected.ok, true)
    if (!connected.ok) return

    const result = await connected.value.callTool('workstream_summaries_vector_search', {})

    assert.deepEqual(result, { ok: false, error: SyncFailure.McpCallFailed })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('categoryFromKeywords picks the category the text talks about most', () => {
  assert.equal(categoryFromKeywords('Fixed a bug, then another bug'), MemoryCategory.ResolvedBugs)
  assert.equal(
    categoryFromKeywords('Revisited the architecture of the loader'),
    MemoryCategory.ArchitectureDecisions,
  )
  assert.equal(categoryFromKeywords('Adjusted the setup script'), MemoryCategory.EnvironmentGotchas)
})

test('categoryFromKeywords gives up rather than guessing', () => {
  assert.equal(categoryFromKeywords('Shipped the release notes'), null)
})

test('isAnchoredToProject keeps bullets that touch the project vocabulary', () => {
  assert.equal(isAnchoredToProject('Rewrote the parser to cut allocations', VOCABULARY), true)
  assert.equal(isAnchoredToProject('Chose PostgreSQL over MongoDB', VOCABULARY), true)
})

test('isAnchoredToProject drops any bullet that references an identified person', () => {
  const bullet =
    'Collaborated with [Jean Doe](pieces://persons/4fe4f1f6) on the parser and PostgreSQL schema'

  assert.equal(isAnchoredToProject(bullet, VOCABULARY), false)
})

test('isAnchoredToProject matches a multi-word term whose parts are too short alone', () => {
  const vocabulary: ReadonlySet<string> = new Set(['to-do'])

  assert.equal(isAnchoredToProject('Rewrote the to-do list rendering', vocabulary), true)
  assert.equal(isAnchoredToProject('Rewrote the list rendering', vocabulary), false)
})

test('isAnchoredToProject ignores generic folder names as anchors', () => {
  const vocabulary: ReadonlySet<string> = new Set(['owlsql'])
  const bullet = 'Drafted a support email about an SSL error on a client src config'

  assert.equal(isAnchoredToProject(bullet, vocabulary), false)
})

test('collectProjectVocabulary skips build artifacts one level down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-vocab-'))
  await mkdir(join(root, 'frontend', 'dist'), { recursive: true })
  await mkdir(join(root, 'frontend', 'node_modules'), { recursive: true })
  await mkdir(join(root, 'frontend', 'coverage'), { recursive: true })
  await mkdir(join(root, 'frontend', 'widgets'), { recursive: true })

  const vocabulary = await collectProjectVocabulary(root, ['myproj'])

  assert.equal(vocabulary.has('dist'), false)
  assert.equal(vocabulary.has('coverage'), false)
  assert.equal(vocabulary.has('modules'), false)
  assert.equal(vocabulary.has('frontend'), true)
  assert.equal(vocabulary.has('widgets'), true)
  assert.equal(vocabulary.has('myproj'), true)
})

test('collectProjectVocabulary reads a package.json that starts with a BOM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-bom-'))
  await writeFile(
    join(root, 'package.json'),
    '\uFEFF{"name":"widget-factory","dependencies":{"knexjs-fork":"1.0.0"}}',
    'utf8',
  )

  const vocabulary = await collectProjectVocabulary(root, ['myproj'])

  assert.equal(vocabulary.has('widget'), true)
  assert.equal(vocabulary.has('factory'), true)
  assert.equal(vocabulary.has('knexjs'), true)
})

const manifestVocabularyCases: ReadonlyArray<{
  readonly filename: string
  readonly content: string
  readonly expectedTerms: ReadonlyArray<string>
  readonly excludedTerms?: ReadonlyArray<string>
}> = [
  {
    filename: 'pyproject.toml',
    content: `[project]
name = """signal-bridge"""
description = """
[tool.poetry.dependencies]
private-client = "1"
"""
dependencies = [
  """urllib3>=2""",
  "httpx>=0.27",
  "requests[socks]>=2",
  "pydantic-settings[dotenv]>=2"
] # "private-client"

[project.optional-dependencies]
docs = ["mkdocs-material>=9"]

[tool.poetry.dependencies]
python = "^3.12"
rich-click = "^1.8"

[tool.poetry.group.dev.dependencies]
ruff = "^0.12"
`,
    expectedTerms: [
      'signal', 'bridge', 'urllib3', 'httpx', 'requests', 'pydantic', 'settings', 'mkdocs', 'material', 'rich', 'click', 'ruff',
    ],
    excludedTerms: ['private-client', 'private', 'client'],
  },
  {
    filename: 'go.mod',
    content: `module example.com/acme/ledger-service

require (
  github.com/jackc/pgx/v5 v5.7.0
  golang.org/x/sync v0.16.0 // indirect
)

require github.com/stretchr/testify v1.10.0
`,
    expectedTerms: ['ledger', 'jackc', 'pgx', 'stretchr', 'testify'],
  },
  {
    filename: 'Cargo.toml',
    content: `[package]
name = '''event-router'''
description = '''
[dependencies]
private-client = "1"
'''

[dependencies]
serde_json = "1"

[dev-dependencies]
proptest = "1"

[build-dependencies]
bindgen = "0.72"

[workspace.dependencies]
tracing = "0.1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[dependencies.reqwest]
version = "0.12"
`,
    expectedTerms: [
      'event', 'router', 'serde_json', 'serde', 'proptest', 'bindgen', 'tracing', 'libc', 'reqwest',
    ],
  },
  {
    filename: 'src/Payments.Worker/Payments.Worker.csproj',
    content: `<!DOCTYPE Project [
  <!-- ]> -->
  <!ENTITY fake "<PackageReference Include='Private.Client' />">
]>
<Project Sdk="Microsoft.NET.Sdk">
  <?probe <AssemblyName>Private.Client</AssemblyName><PackageReference Include="Private.Client" /> ?>
  <!-- documentation mentions <![CDATA[ syntax -->
  <PropertyGroup>
    <AssemblyName>Acme.Billing.Runtime</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Npgsql" Version="8.0.0" />
    <PackageReference Update="Serilog.Sinks.Console" Version="6.0.0" />
    <!-- <PackageReference Include="Private.Client" Version="1.0.0" /> -->
    <![CDATA[
      <AssemblyName>Private.Client</AssemblyName>
      <PackageReference Include="Private.Client" Version="1.0.0" />
    ]]>
  </ItemGroup>
</Project>
`,
    expectedTerms: ['payments', 'acme', 'billing', 'npgsql', 'serilog', 'sinks'],
    excludedTerms: ['private.client', 'private', 'client'],
  },
  {
    filename: 'composer.json',
    content: JSON.stringify({
      name: 'acme/report-engine',
      require: {
        composer: '*',
        'composer-plugin-api': '*',
        'composer-runtime-api': '*',
        'ext-json': '*',
        'guzzlehttp/guzzle': '^7.9',
        'lib-curl': '*',
        php: '>=8.3',
        'php-64bit': '*',
        'php-debug': '*',
        'php-ipv6': '*',
        'php-zts': '*',
      },
      'require-dev': { 'phpunit/phpunit': '^11.0' },
    }),
    expectedTerms: ['acme', 'report', 'engine', 'guzzlehttp', 'guzzle', 'phpunit'],
    excludedTerms: ['64bit', 'composer', 'curl', 'debug', 'ext-json', 'ipv6', 'plugin', 'runtime-api', 'zts'],
  },
  {
    filename: 'Gemfile',
    content: `source "https://rubygems.org"
gem "sidekiq"
gem('dry-monads', '~> 1.6')
=begin
gem "private-client"
=end
message = <<~TEXT
gem "private-client"
TEXT
first, second = <<FIRST, <<SECOND
plain text
FIRST
gem "private-client"
SECOND
plain = <<PLAIN
  PLAIN
gem "private-client"
PLAIN
groups = []
optional_group = :development
groups << optional_group
gem "remote-source", git: "https://example.test/repo?token=<<END"
gem "after-url"
`,
    expectedTerms: [
      'sidekiq', 'dry-monads', 'dry', 'monads', 'remote-source', 'remote', 'source', 'after-url', 'after',
    ],
    excludedTerms: ['private-client', 'private', 'client'],
  },
]

for (const manifest of manifestVocabularyCases) {
  test(`collectProjectVocabulary reads ${manifest.filename}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'p2a-manifest-'))
    t.after(async () => { await rm(root, { recursive: true, force: true }) })
    const manifestPath = join(root, manifest.filename)
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, manifest.content, 'utf8')

    const vocabulary = await collectProjectVocabulary(root, [])

    for (const term of manifest.expectedTerms) assert.equal(vocabulary.has(term), true, term)
    for (const term of manifest.excludedTerms ?? []) assert.equal(vocabulary.has(term), false, term)
    assert.equal(vocabulary.has('com'), false)
    assert.equal(vocabulary.has('php'), false)
    assert.equal(vocabulary.has('python'), false)
  })
}

test('collectProjectVocabulary stays empty when optional manifests are missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-no-manifest-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })

  const vocabulary = await collectProjectVocabulary(root, [])

  assert.deepEqual([...vocabulary], [])
})

test('collectProjectVocabulary ignores malformed optional manifests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-bad-manifest-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const malformedFiles = [
    ['package.json', '{'],
    ['pyproject.toml', '['],
    ['go.mod', 'require'],
    ['Cargo.toml', '[dependencies'],
    ['broken.csproj', '<Project><PackageReference'],
    ['composer.json', '{'],
    ['Gemfile', 'gem'],
  ] as const

  for (const [filename, content] of malformedFiles) {
    await writeFile(join(root, filename), content, 'utf8')
  }

  const vocabulary = await collectProjectVocabulary(root, [])

  assert.deepEqual([...vocabulary], [])
})

test('collectProjectVocabulary ignores oversized manifests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-large-manifest-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const padding = 'x'.repeat(300_000)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'private-client', padding }), 'utf8')

  const vocabulary = await collectProjectVocabulary(root, [])

  assert.deepEqual([...vocabulary], [])
})

test('collectProjectVocabulary caps terms from a large manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-many-terms-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const dependencies = Object.fromEntries(
    Array.from({ length: 5_100 }, (_, index) => [`dependency-${index}`, '*']),
  )
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies }), 'utf8')

  const vocabulary = await collectProjectVocabulary(root, [])

  assert.equal(vocabulary.size, 600)
})

test('collectProjectVocabulary preserves terms from each manifest source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-fair-manifests-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const dependencies = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [`dependency-${index}`, '*']),
  )
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies }), 'utf8')
  await writeFile(
    join(root, 'pyproject.toml'),
    `[project]
dependencies = ${JSON.stringify([
      'sqlalchemy>=2',
      ...Array.from({ length: 5_100 }, (_, index) => `unique${index}`),
    ])}
name = "critical-python-service"
`,
    'utf8',
  )
  await writeFile(
    join(root, 'Cargo.toml'),
    '[package]\nname = "critical-rust-service"\n[dependencies]\ntokio = "1"\n',
    'utf8',
  )

  const vocabulary = await collectProjectVocabulary(root, [])

  for (const term of ['critical-python-service', 'sqlalchemy', 'critical-rust-service', 'tokio']) {
    assert.equal(vocabulary.has(term), true, term)
  }
})

test('collectProjectVocabulary ignores symlinked manifests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-symlink-manifest-'))
  const outside = await mkdtemp(join(tmpdir(), 'p2a-outside-manifest-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const outsideManifest = join(outside, 'package.json')
  await writeFile(outsideManifest, '{"name":"private-client"}', 'utf8')

  try {
    await symlink(outsideManifest, join(root, 'package.json'), 'file')
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`symlinks unavailable: ${code}`)
      return
    }
    throw error
  }

  const vocabulary = await collectProjectVocabulary(root, [])

  assert.deepEqual([...vocabulary], [])
})

test('isAnchoredToProject drops bullets from a mixed session', () => {
  const offTopic = [
    'Browsed and reviewed job listings on a jobs board',
    'Coordinated repo updates with a colleague over WhatsApp',
    'Engaged in extended DayZ gameplay on server 188.255.171.159:2302',
    'Drafted a support email about an SSL error on a client domain',
  ]

  for (const bullet of offTopic) {
    assert.equal(isAnchoredToProject(bullet, VOCABULARY), false, bullet)
  }
})

test('composeBlock drops an entry once its bullets are all off topic', () => {
  const block = composeBlock(
    [entry({ text: '- Played DayZ all evening\n- Reviewed job listings' })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.doesNotMatch(block, /Architecture decisions/)
})

test('composeBlock drops a whole bullet that mentions a denied term', () => {
  const text =
    '- Chose PostgreSQL over MongoDB for relational integrity\n' +
    '- Reviewed the Vivarium audit while working on the parser'

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: ['vivarium'] },
  )

  assert.match(block, /Chose PostgreSQL/)
  assert.doesNotMatch(block, /Vivarium/i)
  assert.doesNotMatch(block, /parser/)
})

test('composeBlock drops a denied bullet instead of masking the term', () => {
  const text =
    '- Chose PostgreSQL over MongoDB for relational integrity\n' +
    '- Set the LICENSE name field to Jane Doe while wiring the parser'

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: ['Jane Doe'] },
  )

  assert.match(block, /Chose PostgreSQL/)
  assert.doesNotMatch(block, /LICENSE name field/)
  assert.doesNotMatch(block, /redacted/)
})

test('resolveTargetFile accepts either file, with or without case and extension', () => {
  assert.equal(resolveTargetFile('CLAUDE.md'), TargetFile.Claude)
  assert.equal(resolveTargetFile('claude.md'), TargetFile.Claude)
  assert.equal(resolveTargetFile('claude'), TargetFile.Claude)
  assert.equal(resolveTargetFile('AGENTS.md'), TargetFile.Agents)
  assert.equal(resolveTargetFile(' agents '), TargetFile.Agents)
})

test('resolveTargetFile rejects anything else instead of falling back silently', () => {
  assert.equal(resolveTargetFile('README.md'), null)
  assert.equal(resolveTargetFile('CLAUDE.txt'), null)
  assert.equal(resolveTargetFile(''), null)
})

test('resolveWindowDays accepts a positive whole number and defaults when absent', () => {
  assert.equal(resolveWindowDays('30'), 30)
  assert.equal(resolveWindowDays(' 14 '), 14)
  assert.equal(resolveWindowDays(undefined), DEFAULT_WINDOW_DAYS)
})

test('resolveWindowDays rejects anything else instead of falling back silently', () => {
  assert.equal(resolveWindowDays('0'), null)
  assert.equal(resolveWindowDays('-5'), null)
  assert.equal(resolveWindowDays('30abc'), null)
  assert.equal(resolveWindowDays('abc'), null)
  assert.equal(resolveWindowDays(''), null)
})

test('CLIENT_VERSION mirrors the package.json version', async () => {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(raw) as { version: string }

  assert.equal(CLIENT_VERSION, manifest.version)
})

test('composeBlock redacts denied terms in the session title', () => {
  const block = composeBlock(
    [entry({ title: 'Demo Refactor and AcmeCorp Troubleshooting' })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: ['AcmeCorp'] },
  )

  assert.doesNotMatch(block, /AcmeCorp/i)
  assert.match(block, /Demo Refactor/)
})

test('trimTitleToProject drops the half of a title about other work', () => {
  const filters = { vocabulary: new Set(['owlsql']), deniedTerms: [] }

  assert.equal(trimTitleToProject('OwlSQL Refactoring and Job Search', filters), 'OwlSQL Refactoring')
  assert.equal(trimTitleToProject('OwlSQL Audit and Gameplay', filters), 'OwlSQL Audit')
  assert.equal(trimTitleToProject('OwlSQL Audit and OwlSQL Release', filters), 'OwlSQL Audit and OwlSQL Release')
})

test('trimTitleToProject keeps the title when no half is anchored', () => {
  const filters = { vocabulary: new Set(['owlsql']), deniedTerms: [] }

  assert.equal(trimTitleToProject('Planning and Review', filters), 'Planning and Review')
})

test('composeBlock drops bullets that describe work still to do', () => {
  const text =
    '- Chose PostgreSQL over MongoDB for relational integrity\n' +
    '- Resolve merge conflicts in the demo parser branch\n' +
    '- Finalize the demo README before release'

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /Chose PostgreSQL/)
  assert.doesNotMatch(block, /merge conflicts/)
  assert.doesNotMatch(block, /Finalize/)
})

test('composeBlock drops bullets left as nothing but a placeholder', () => {
  const text =
    '- Chose PostgreSQL over MongoDB for relational integrity\n' +
    '- `F:\\work\\demo\\diagram.html` (standalone diagram with 12 nodes)\n' +
    '- Patched the demo parser in F:\\work\\demo\\src\\parse.ts'

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /Chose PostgreSQL/)
  assert.doesNotMatch(block, /standalone diagram/)
  assert.doesNotMatch(block, /\[local path\]\s*$/m)
})

test('composeBlock keeps only bullets written as something that happened', () => {
  const text = [
    '- Chose PostgreSQL over MongoDB for relational integrity',
    '- Ran the demo parser suite and confirmed a clean build',
    '- You merged the demo parser fix',
    '- demo repository and pull requests pages (multiple views of https://example.com/demo)',
    '- Local demo scratchpad files created during the parser audit',
    '- docs/demo-architecture.json (noted as outdated)',
  ].join('\n')

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /Chose PostgreSQL/)
  assert.match(block, /Ran the demo parser suite/)
  assert.match(block, /merged the demo parser fix/)
  assert.doesNotMatch(block, /pull requests pages/)
  assert.doesNotMatch(block, /scratchpad files/)
  assert.doesNotMatch(block, /demo-architecture\.json/)
})

test('composeBlock skips bullets that are only a link', () => {
  const text =
    '- [pieces-to-agents - npm](https://www.npmjs.com/package/pieces-to-agents)\n' +
    '- Rewrote the parser to cut allocations'

  const block = composeBlock(
    [entry({ text })],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /Rewrote the parser/)
  assert.doesNotMatch(block, /npmjs\.com/)
})

test('composeBlock applies the entry cap after rendering, not before', () => {
  const empty = entry({ text: 'Prose only, nothing to keep.' })
  const rich = entry({ text: '- Chose PostgreSQL over MongoDB for relational integrity' })

  const block = composeBlock(
    [empty, empty, empty, empty, rich],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  assert.match(block, /Chose PostgreSQL/)
})

test('parseEventStreamMessage reads a JSON-RPC message out of an SSE body', () => {
  const raw =
    'event: message\ndata: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"{}"}]}}\n\n'

  assert.deepEqual(parseEventStreamMessage(raw), {
    jsonrpc: '2.0',
    id: '1',
    result: { content: [{ type: 'text', text: '{}' }] },
  })
})

test('parseEventStreamMessage skips events that carry no JSON', () => {
  const raw = 'event: ping\n\ndata: not json\n\ndata: {"jsonrpc":"2.0","id":"2","result":{}}\n\n'

  assert.deepEqual(parseEventStreamMessage(raw), { jsonrpc: '2.0', id: '2', result: {} })
})

test('parseEventStreamMessage returns null when nothing parses', () => {
  assert.equal(parseEventStreamMessage('event: ping\n\n'), null)
  assert.equal(parseEventStreamMessage('not an event stream at all'), null)
})

test('parseEventStreamMessage skips a notification that precedes the response', () => {
  const raw =
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n' +
    'data: {"jsonrpc":"2.0","id":"42","result":{}}\n\n'

  assert.deepEqual(parseEventStreamMessage(raw), { jsonrpc: '2.0', id: '42', result: {} })
})

test('parseEventStreamMessage picks the response matching the request id', () => {
  const raw =
    'data: {"jsonrpc":"2.0","id":"other","result":{"stale":true}}\n\n' +
    'data: {"jsonrpc":"2.0","id":"42","result":{"fresh":true}}\n\n'

  assert.deepEqual(parseEventStreamMessage(raw, '42'), {
    jsonrpc: '2.0',
    id: '42',
    result: { fresh: true },
  })
})

test('parseEventStreamMessage rejects a response with another request id', () => {
  const raw = 'data: {"jsonrpc":"2.0","id":"stale","result":{}}\n\n'

  assert.equal(parseEventStreamMessage(raw, 'expected'), null)
})

test('composeBlock keeps an older entry the current search no longer returns', () => {
  const previous = composeBlock(
    [entry({ title: 'Old session', createdAt: '2026-06-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 90, generatedAt: '2026-06-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  const next = composeBlock(
    [entry({ title: 'New session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 3, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
    previous,
  )

  assert.match(next, /New session/)
  assert.match(next, /Old session/)
})

test('composeBlock does not duplicate an entry that came back again', () => {
  const previous = composeBlock(
    [entry({ title: 'Same session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  const next = composeBlock(
    [entry({ title: 'Same session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
    previous,
  )

  assert.equal((next.match(/Same session/g) ?? []).length, 1)
})

test('composeBlock lets newer entries push the oldest out of a full category', () => {
  const older = [1, 2, 3, 4].map((n) =>
    entry({ title: `Session ${n}`, createdAt: `2026-06-0${n}T10:00:00.000Z` }),
  )
  const previous = composeBlock(
    older,
    { project: 'demo', windowDays: 90, generatedAt: '2026-06-05' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  const next = composeBlock(
    [entry({ title: 'Newest session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 3, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
    previous,
  )

  assert.match(next, /Newest session/)
  assert.doesNotMatch(next, /Session 1\b/)
  assert.match(next, /Session 4/)
})

test('composeBlock drops a kept bullet once its term joins the deny-list', () => {
  const text =
    '- Chose PostgreSQL over MongoDB for relational integrity\n' +
    '- Reviewed the AcmeCorp contract while wiring the parser'

  const previous = composeBlock(
    [entry({ title: 'Old session', createdAt: '2026-07-01T10:00:00.000Z', text })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-07-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )
  assert.match(previous, /AcmeCorp/)

  const next = composeBlock(
    [entry({ title: 'Fresh session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: ['acmecorp'] },
    previous,
  )

  assert.doesNotMatch(next, /acmecorp/i)
  assert.match(next, /Old session/)
  assert.match(next, /Chose PostgreSQL/)
})

test('composeBlock drops a kept entry when every bullet mentions a denied term', () => {
  const previous = composeBlock(
    [entry({
      title: 'Old session',
      createdAt: '2026-07-01T10:00:00.000Z',
      text: '- Reviewed the AcmeCorp contract while wiring the parser',
    })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-07-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  const next = composeBlock(
    [entry({ title: 'Fresh session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: ['acmecorp'] },
    previous,
  )

  assert.doesNotMatch(next, /acmecorp/i)
  assert.doesNotMatch(next, /Old session/)
})

test('composeBlock redacts a denied term from a kept heading', () => {
  const previous = composeBlock(
    [entry({ title: 'Demo Refactor and AcmeCorp Troubleshooting', createdAt: '2026-07-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-07-01' },
    { vocabulary: new Set(['demo', 'acmecorp', 'postgresql', 'mongodb']), deniedTerms: [] },
  )
  assert.match(previous, /AcmeCorp/)

  const next = composeBlock(
    [entry({ title: 'Fresh session', createdAt: '2026-08-01T10:00:00.000Z' })],
    { project: 'demo', windowDays: 30, generatedAt: '2026-08-02' },
    { vocabulary: VOCABULARY, deniedTerms: ['acmecorp'] },
    previous,
  )

  assert.doesNotMatch(next, /acmecorp/i)
  assert.match(next, /\[redacted\] Troubleshooting/)
})

test('composeBlock output round-trips through spliceManagedBlock', () => {
  const block = composeBlock(
    [entry()],
    { project: 'demo', windowDays: 14, generatedAt: '2026-08-01' },
    { vocabulary: VOCABULARY, deniedTerms: [] },
  )

  const first = spliceManagedBlock('# Repo\n\nKeep me.\n', block)
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = spliceManagedBlock(first.value, block)
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.value, first.value)
})

test('collectProjectVocabulary does not anchor on agent files or framework folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-generic-'))
  await mkdir(join(root, 'src', 'models'), { recursive: true })
  await mkdir(join(root, 'src', 'components'), { recursive: true })
  await writeFile(join(root, 'CLAUDE.md'), '# rules', 'utf8')
  await writeFile(join(root, 'AGENTS.md'), '# rules', 'utf8')

  const vocabulary = await collectProjectVocabulary(root, ['vivarium'])

  assert.equal(vocabulary.has('claude'), false)
  assert.equal(vocabulary.has('agents'), false)
  assert.equal(vocabulary.has('models'), false)
  assert.equal(vocabulary.has('components'), false)
  assert.equal(vocabulary.has('vivarium'), true)

  assert.equal(
    isAnchoredToProject('Signed in to the Claude desktop application on Windows', vocabulary),
    false,
  )
  assert.equal(
    isAnchoredToProject('Read news coverage about an open-source model release', vocabulary),
    false,
  )
  assert.equal(isAnchoredToProject('Fixed the vivarium switchWorld race', vocabulary), true)
})

test('collectProjectVocabulary keeps a project term that reads as generic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-generic-name-'))

  const vocabulary = await collectProjectVocabulary(root, ['agents'])

  assert.equal(vocabulary.has('agents'), true)
})

test('collectProjectVocabulary ignores root documents as project anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-root-docs-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'SECURITY.md'), '# Security', 'utf8')
  await writeFile(join(root, 'ARCHITECTURE.md'), '# Architecture', 'utf8')
  await writeFile(join(root, 'invoice-reconciler.py'), 'print("ready")', 'utf8')
  await writeFile(join(root, 'payment-export.dart'), 'void main() {}', 'utf8')
  await writeFile(join(root, 'audit-report.sql'), 'select 1;', 'utf8')
  await writeFile(join(root, 'cache-cleaner.sh'), 'exit 0', 'utf8')
  await writeFile(join(root, 'event-router.lua'), 'return {}', 'utf8')
  await writeFile(join(root, 'security.ts'), 'export {}', 'utf8')
  await writeFile(join(root, 'auth.ts'), 'export {}', 'utf8')
  await writeFile(join(root, 'Dockerfile'), 'FROM scratch', 'utf8')
  await writeFile(join(root, 'Makefile'), 'all:', 'utf8')
  await writeFile(join(root, 'CHANGELOG'), 'Initial release', 'utf8')
  await writeFile(join(root, 'client-security.markdown'), '# Security', 'utf8')
  await writeFile(join(root, 'CODE_OF_CONDUCT'), 'Be kind', 'utf8')
  await writeFile(join(root, 'client-roadmap.pptx'), 'presentation', 'utf8')
  await writeFile(join(root, 'team-budget.xlsx'), 'spreadsheet', 'utf8')
  await writeFile(join(root, 'release-plan.org'), 'notes', 'utf8')
  await writeFile(join(root, 'src', 'parser.ts'), 'export {}', 'utf8')

  const vocabulary = await collectProjectVocabulary(root, ['demo'])

  assert.equal(vocabulary.has('security'), false)
  assert.equal(vocabulary.has('auth'), false)
  assert.equal(vocabulary.has('dockerfile'), false)
  assert.equal(vocabulary.has('makefile'), false)
  assert.equal(vocabulary.has('changelog'), false)
  assert.equal(vocabulary.has('client-security'), false)
  assert.equal(vocabulary.has('code_of_conduct'), false)
  assert.equal(vocabulary.has('client-roadmap'), false)
  assert.equal(vocabulary.has('team-budget'), false)
  assert.equal(vocabulary.has('release-plan'), false)
  assert.equal(vocabulary.has('architecture'), false)
  assert.equal(vocabulary.has('invoice-reconciler'), true)
  assert.equal(vocabulary.has('payment-export'), true)
  assert.equal(vocabulary.has('audit-report'), true)
  assert.equal(vocabulary.has('cache-cleaner'), true)
  assert.equal(vocabulary.has('event-router'), true)
  assert.equal(vocabulary.has('parser'), true)
  assert.equal(isAnchoredToProject('Reviewed the neighbour-app security posture', vocabulary), false)
  assert.equal(isAnchoredToProject('Rewrote the invoice reconciler to catch duplicate rows', vocabulary), true)
  assert.equal(isAnchoredToProject('Fixed security checks in unrelated-client', vocabulary), false)
  assert.equal(isAnchoredToProject('Fixed auth in unrelated-client', vocabulary), false)
})

test('CLI writes only after approval and preserves existing content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2a-cli-'))
  const targetPath = join(root, 'AGENTS.md')
  const preloadPath = join(root, 'mock-mcp.mjs')
  const original = '# Notes\n\nKeep me.\n'

  try {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'parser.ts'), 'export {}', 'utf8')
    await writeFile(targetPath, original, 'utf8')
    await writeFile(
      preloadPath,
      `const project = process.cwd().split(/[\\\\/]/).at(-1)
const createdAt = new Date().toISOString()
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })

  let payload = {}
  if (body.method === 'tools/call') {
    const tool = body.params?.name
    if (tool === 'workstream_summaries_vector_search') payload = { results: [] }
    if (tool === 'workstream_summaries_full_text_search') {
      payload = { results: [{ summary: { id: 'summary-1' } }] }
    }
    if (tool === 'workstream_summaries_batch_snapshot') {
      payload = {
        items: [{
          id: 'summary-1',
          name: project + ' maintenance',
          created: { value: createdAt },
          annotations: { indices: { 'annotation-1': {} } },
        }],
      }
    }
    if (tool === 'annotations_batch_snapshot') {
      payload = {
        items: [{
          id: 'annotation-1',
          type: 'SUMMARY',
          text: '- Rewrote the parser to preserve approved content',
        }],
      }
    }
  }

  const result = body.method === 'tools/call'
    ? { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    : {}
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'test' } },
  )
}
`,
      'utf8',
    )

    const cancelled = await runCli(root, preloadPath, 'n\n')
    assert.equal(cancelled.code, 1, cancelled.stderr)
    assert.match(cancelled.stdout, /Proposed changes to AGENTS\.md/)
    assert.equal(await readFile(targetPath, 'utf8'), original)

    const approved = await runCli(root, preloadPath, 'y\n')
    assert.equal(approved.code, 0, approved.stderr)
    assert.match(approved.stdout, /Wrote AGENTS\.md with 1 memories/)

    const written = await readFile(targetPath, 'utf8')
    assert.match(written, /Keep me\./)
    assert.match(written, /Rewrote the parser to preserve approved content/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detectCandidateEntities flags an unknown mid-sentence proper noun', () => {
  const candidates = detectCandidateEntities(
    '- Chose PostgreSQL over Hostinger for the demo deployment',
    VOCABULARY,
  )

  assert.deepEqual(candidates, ['Hostinger'])
})

test('detectCandidateEntities groups consecutive unknown words into one candidate', () => {
  const candidates = detectCandidateEntities(
    '- Met with Marcos Silva about the parser rollout',
    VOCABULARY,
  )

  assert.deepEqual(candidates, ['Marcos Silva'])
})

test('detectCandidateEntities skips the sentence-initial word', () => {
  const candidates = detectCandidateEntities('- Fixed the parser after the crash', VOCABULARY)

  assert.deepEqual(candidates, [])
})

test('detectCandidateEntities skips acronyms stop terms and vocabulary', () => {
  const candidates = detectCandidateEntities(
    '- Parsed the JWT on Windows after GitHub rejected the PostgreSQL login',
    VOCABULARY,
  )

  assert.deepEqual(candidates, [])
})

test('detectCandidateEntities keeps a name with internal capitals or digits', () => {
  const candidates = detectCandidateEntities(
    '- Debugged the parser against Auth0 and OwlSQL fixtures',
    VOCABULARY,
  )

  assert.deepEqual(candidates, ['Auth0', 'OwlSQL'])
})

test('detectCandidateEntities reads bullets only and reports each name once', () => {
  const candidates = detectCandidateEntities(
    [
      '### Architecture decisions',
      '',
      '**Hostinger Migration** — 2026-08-01',
      '',
      '- Moved the demo parser away from Hostinger',
      '- Confirmed with Hostinger support that the demo plan expired',
    ].join('\n'),
    VOCABULARY,
  )

  assert.deepEqual(candidates, ['Hostinger'])
})
