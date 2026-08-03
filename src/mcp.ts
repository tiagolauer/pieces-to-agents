import {
  CALL_TIMEOUT_MS,
  CLIENT_NAME,
  CLIENT_VERSION,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
  SyncFailure,
  err,
  ok,
  type Result,
} from './core.ts'

type JsonRpcResponse = {
  result?: { content?: ReadonlyArray<{ type?: string; text?: string }> }
  error?: { message?: string }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isTimeout = (caught: unknown): boolean =>
  isRecord(caught) && (caught.name === 'TimeoutError' || caught.name === 'AbortError')

export const parseEventStreamMessage = (raw: string, requestId?: string): unknown => {
  const messages: unknown[] = []

  for (const event of raw.split(/\r?\n\r?\n/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))
    if (dataLines.length === 0) continue

    try {
      messages.push(JSON.parse(dataLines.join('\n')))
    } catch {
      continue
    }
  }

  if (requestId !== undefined) {
    const matching = messages.find((message) => isRecord(message) && message.id === requestId)
    if (matching !== undefined) return matching
  }

  const response = messages.find(
    (message) => isRecord(message) && ('result' in message || 'error' in message),
  )
  return response ?? messages[0] ?? null
}

export class McpClient {
  private sessionId: string | null = null

  private constructor(private readonly endpoint: string) {}

  static async connect(endpoint: string = MCP_ENDPOINT): Promise<Result<McpClient, SyncFailure>> {
    const client = new McpClient(endpoint)

    const handshake = await client.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    })

    if (!handshake.ok) return handshake

    await client.notify('notifications/initialized')
    return ok(client)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Result<unknown, SyncFailure>> {
    const response = await this.send('tools/call', { name, arguments: args })
    if (!response.ok) {
      process.stderr.write(`  while calling ${name}\n`)
      return response
    }

    const text = response.value.result?.content?.[0]?.text
    if (typeof text !== 'string') {
      process.stderr.write(`  ${name} answered without any content\n`)
      return err(SyncFailure.McpCallFailed)
    }

    try {
      return ok(JSON.parse(text) as unknown)
    } catch {
      return ok(text)
    }
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<JsonRpcResponse, SyncFailure>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const requestId = crypto.randomUUID()
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    })

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (caught) {
      if (method === 'initialize') return err(SyncFailure.PiecesOsUnreachable)
      return err(isTimeout(caught) ? SyncFailure.McpTimeout : SyncFailure.McpCallFailed)
    }

    if (!response.ok) {
      process.stderr.write(`  PiecesOS answered ${response.status} ${response.statusText}\n`)
      return err(method === 'initialize' ? SyncFailure.McpHandshakeFailed : SyncFailure.McpCallFailed)
    }

    const returnedSession = response.headers.get('mcp-session-id')
    if (returnedSession) this.sessionId = returnedSession

    const raw = await response.text()

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = parseEventStreamMessage(raw, requestId)
      if (parsed === null) return err(SyncFailure.McpCallFailed)
    }

    if (!isRecord(parsed)) return err(SyncFailure.McpCallFailed)

    if (isRecord(parsed.error)) {
      const detail = typeof parsed.error.message === 'string' ? parsed.error.message : 'no detail'
      process.stderr.write(`  PiecesOS refused the call: ${detail}\n`)
      return err(SyncFailure.McpCallFailed)
    }

    return ok(parsed as JsonRpcResponse)
  }

  private async notify(method: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params: {} }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch {
      return
    }
  }
}
