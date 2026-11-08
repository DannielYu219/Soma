import type { ServerResponse } from 'node:http'
import type { Config } from './config.ts'

/** A tool call the upstream model asked for, with arguments as the raw JSON string it produced. */
export interface ToolCall { id: string; name: string; args: string }

/** Everything one upstream turn produced, in the upstream protocol's own shape where needed. */
export interface Turn { text: string; calls: ToolCall[]; raw: unknown[] }

/** Live callbacks while an upstream turn is still streaming. */
export interface TurnHandlers {
  text(delta: string): void
  thinking(delta: string): void
  signature(value: string): void
}

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface Writer { res: ServerResponse; stream: boolean }

/** Downstream side: writes the client's protocol, either as SSE or as one JSON body. */
export interface Sink {
  text(delta: string): void
  thinking(delta: string): void
  signature(value: string): void
  calls(calls: ToolCall[]): void
  finish(hasCalls: boolean): void
  fail(error: ApiError): void
}

export interface ApiError { status: number; type: string; message: string }

export interface Adapter {
  /** Key in the upstream request body that holds the conversation items. */
  itemsKey: 'messages' | 'input'
  init(body: Record<string, unknown>): unknown[]
  /** Client tools pass through, minus hosted web search and any client tool named like ours. */
  tools(client: unknown, spec: ToolSpec | null): unknown[]
  upstreamUrl(cfg: Config): string
  upstreamHeaders(cfg: Config, incoming: Record<string, string | string[] | undefined>): Record<string, string>
  parse(response: Response, handlers: TurnHandlers): Promise<Turn>
  appendTurn(items: unknown[], turn: Turn): void
  appendResults(items: unknown[], results: Array<{ call: ToolCall; output: string }>): void
  createSink(writer: Writer, model: string): Sink
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The upstream model service answered with an error or a broken stream. */
export class UpstreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpError) return { status: error.status, type: 'invalid_request_error', message: error.message }
  if (error instanceof UpstreamError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502
    return { status, type: 'upstream_error', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 502, type: 'api_error', message: `后端内部错误：${message}` }
}
