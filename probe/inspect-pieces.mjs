import { argv } from 'node:process'

const ENDPOINT = 'http://localhost:39300/model_context_protocol/2025-03-26/mcp'
const PROTOCOL_VERSION = '2025-03-26'

let sessionId = null

async function rpc(method, params, isNotification = false) {
  const payload = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: crypto.randomUUID(), method, params }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  const returned = response.headers.get('mcp-session-id')
  if (returned) sessionId = returned

  const text = await response.text()
  return isNotification ? null : JSON.parse(text)
}

async function callTool(name, args) {
  const response = await rpc('tools/call', { name, arguments: args })
  const text = response?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function connect() {
  const handshake = await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pieces-to-agents-probe', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {}, true)
  return handshake?.result?.serverInfo
}

async function listTools() {
  const response = await rpc('tools/list', {})
  const tools = response?.result?.tools ?? []

  console.log(`${tools.length} tools exposed\n`)
  for (const tool of tools) {
    const params = Object.keys(tool.inputSchema?.properties ?? {})
    const required = tool.inputSchema?.required ?? []
    console.log(tool.name)
    console.log(`  params:   ${params.join(', ') || '(none)'}`)
    console.log(`  required: ${required.join(', ') || '(none)'}\n`)
  }
}

async function traceChain(query) {
  const startedAt = Date.now()

  const search = await callTool('workstream_summaries_vector_search', {
    query,
    limit: 3,
    threshold: 0.35,
  })
  const identifiers = (search?.results ?? []).map((entry) => entry.identifier)
  console.log(`1. vector_search      → ${identifiers.length} identifiers`)

  if (identifiers.length === 0) {
    console.log('\nNo summaries matched. Try a broader query or a lower threshold.')
    return
  }

  const snapshot = await callTool('workstream_summaries_batch_snapshot', { identifiers })
  const summaries = snapshot?.items ?? []
  console.log(`2. batch_snapshot     → ${summaries.length} summaries`)

  const annotationIds = summaries.flatMap((summary) =>
    Object.keys(summary.annotations?.indices ?? {}),
  )
  const annotations = await callTool('annotations_batch_snapshot', { identifiers: annotationIds })
  const items = annotations?.items ?? []
  console.log(`3. annotations        → ${items.length} annotations`)
  console.log(`   elapsed            → ${Date.now() - startedAt} ms\n`)

  const byType = new Map()
  for (const annotation of items) {
    byType.set(annotation.type, (byType.get(annotation.type) ?? 0) + 1)
  }
  console.log('Annotation types found:')
  for (const [type, count] of byType) {
    const blocked = type === 'HIERARCHICAL_PROFILE_SUMMARY' ? '  ← never read by the CLI' : ''
    console.log(`  ${type}: ${count}${blocked}`)
  }

  console.log('\nSummary titles:')
  for (const summary of summaries) {
    console.log(`  ${summary.created?.value?.slice(0, 10)}  ${summary.name}`)
  }
}

const mode = argv[2] ?? 'tools'

const serverInfo = await connect()
console.log(`Connected to ${serverInfo?.name} v${serverInfo?.version}\n`)

if (mode === 'tools') {
  await listTools()
} else if (mode === 'chain') {
  await traceChain(argv[3] ?? 'architecture decisions and technical trade-offs')
} else {
  console.log('Usage: node probe/inspect-pieces.mjs [tools|chain] [query]')
}
