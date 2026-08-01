import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeBlock, spliceManagedBlock } from '../src/agents-file.ts'
import { MARKER_END, MARKER_START, MemoryCategory, SyncFailure } from '../src/core.ts'
import { mentionsProject, type MemoryEntry } from '../src/memory.ts'
import { redact } from '../src/redact.ts'

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

test('redact removes denied terms regardless of case', () => {
  const scrubbed = redact('Reviewed with Jane Doe at AcmeCorp', ['jane doe', 'AcmeCorp'])

  assert.doesNotMatch(scrubbed, /Jane Doe/i)
  assert.doesNotMatch(scrubbed, /AcmeCorp/i)
})

test('composeBlock emits bullets under the category heading', () => {
  const block = composeBlock([entry()], {
    project: 'demo',
    windowDays: 14,
    generatedAt: '2026-08-01',
  })

  assert.match(block, /^<!-- pieces-to-agents:start -->/)
  assert.match(block, /Architecture decisions/)
  assert.match(block, /- Chose PostgreSQL over MongoDB/)
  assert.match(block, /2026-07-30/)
  assert.equal(block.trimEnd().endsWith(MARKER_END), true)
})

test('composeBlock skips entries that carry no bullet content', () => {
  const block = composeBlock([entry({ text: 'Prose only, no bullet list here.' })], {
    project: 'demo',
    windowDays: 14,
    generatedAt: '2026-08-01',
  })

  assert.doesNotMatch(block, /Architecture decisions/)
})

test('mentionsProject keeps memories that name the project or an alias', () => {
  assert.equal(mentionsProject('Refactored the Pieces-To-Agents CLI', ['pieces-to-agents']), true)
  assert.equal(mentionsProject('Debugged the ptha extractor', ['pieces-to-agents', 'ptha']), true)
})

test('mentionsProject rejects memories from unrelated work', () => {
  const unrelated = 'Approved a pull request on an unrelated billing service and updated my resume'

  assert.equal(mentionsProject(unrelated, ['pieces-to-agents']), false)
})

test('composeBlock output round-trips through spliceManagedBlock', () => {
  const block = composeBlock([entry()], {
    project: 'demo',
    windowDays: 14,
    generatedAt: '2026-08-01',
  })

  const first = spliceManagedBlock('# Repo\n\nKeep me.\n', block)
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = spliceManagedBlock(first.value, block)
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.value, first.value)
})
