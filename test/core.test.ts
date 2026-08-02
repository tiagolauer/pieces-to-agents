import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeBlock, spliceManagedBlock, trimTitleToProject } from '../src/agents-file.ts'
import {
  MARKER_END,
  MARKER_START,
  MemoryCategory,
  SyncFailure,
  TargetFile,
  resolveTargetFile,
} from '../src/core.ts'
import { isAboutProject, type MemoryEntry } from '../src/memory.ts'
import { redact } from '../src/redact.ts'
import { isAnchoredToProject } from '../src/vocabulary.ts'

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

test('isAboutProject rejects sessions titled after other work', () => {
  assert.equal(isAboutProject('Senior C# Prep and Architecture', ['pieces-to-agents']), false)
})

test('isAboutProject matches across accents, spacing and separators', () => {
  assert.equal(isAboutProject('Marcô Agenda Rebrand and Refactor', ['marco-agenda']), true)
  assert.equal(isAboutProject('Marco Agenda Rebrand', ['marco_agenda']), true)
  assert.equal(isAboutProject('OwlSQL Audit', ['owl sql']), true)
})

test('isAboutProject ignores a passing mention in the session body', () => {
  const title = 'KangoOS PR and Contract Negotiation'
  const body =
    'Reviewed the Vercel project list including marco-agenda, dori-finance and the portfolio. ' +
    'Negotiated contract terms with a recruiter and set up 2FA recovery codes.'

  assert.equal(isAboutProject(title, ['marco-agenda']), false)
  assert.equal(isAboutProject(`${title}\n${body}`, ['marco-agenda']), true)
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

test('isAnchoredToProject ignores generic folder names as anchors', () => {
  const vocabulary: ReadonlySet<string> = new Set(['owlsql'])
  const bullet = 'Drafted a support email about an SSL error on a client src config'

  assert.equal(isAnchoredToProject(bullet, vocabulary), false)
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
