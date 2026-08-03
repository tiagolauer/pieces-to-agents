import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  isAboutProject,
  searchLimitForWindow,
  type MemoryEntry,
} from '../src/memory.ts'
import { parseEventStreamMessage } from '../src/mcp.ts'
import { redact } from '../src/redact.ts'
import { collectProjectVocabulary, isAnchoredToProject } from '../src/vocabulary.ts'

const VOCABULARY: ReadonlySet<string> = new Set([
  'demo',
  'postgresql',
  'mongodb',
  'graphql',
  'parser',
])

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  category: MemoryCategory.ArchitectureDecisions,
  title: 'Session title',
  createdAt: '2026-07-30T10:00:00.000Z',
  text: '### Decisions\n- Chose PostgreSQL over MongoDB for relational integrity\n- Rejected GraphQL to keep the surface small',
  ...overrides,
})

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
  const unix = redact('Edited /home/tiago/clients/secret-app/src/core.ts today')
  const fileUri = redact('Opened file:///F:/Fontes/Clientes/secret-app/package.json')

  for (const scrubbed of [windows, unix, fileUri]) {
    assert.doesNotMatch(scrubbed, /secret-app/)
    assert.match(scrubbed, /\[local path\]/)
  }
})

test('redact removes phone numbers', () => {
  const international = redact('Outreach from a founder (+39 389 283 6813) about a role')
  const brazilian = redact('Called (11) 98765-4321 to confirm')

  assert.doesNotMatch(international, /389 283 6813/)
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
  const scrubbed = redact('Wrote to F:\\work\\app\\core.ts and mailed dev@example.com')

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
