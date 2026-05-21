// Cloudflare Workers AI REST client.
//
// The agent's whole LLM layer runs on Workers AI (docs/v2-design.md §6, §7).
// We talk to the REST API rather than the `AI` Worker binding so the exact
// same code path works in three places:
//   - `next dev` (plain Node, no Workers runtime, no binding)
//   - the OpenNext/Workers production deployment
//   - offline scripts (scripts/*.mjs keep their own minimal copy)
// The binding would save one egress hop in production but would not work in
// dev or in Node scripts; uniformity wins at this scale.

import { llmConfig, requireLlmCredentials } from "./llm-config";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Token counts as reported by Workers AI. There is no Workers AI context-cache
// product, so the downstream UsageSummary always reports cachedTokens = 0.
export interface WorkersAiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const ZERO_USAGE: WorkersAiUsage = {
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function parseUsage(raw: unknown): WorkersAiUsage {
  if (!raw || typeof raw !== "object") return ZERO_USAGE;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    promptTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

// Carries the HTTP status so lib/llm-errors.ts can map it to a friendly
// message. status is 200 for envelope-level ({success:false}) failures.
export class WorkersAiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkersAiError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RunBody {
  messages?: ChatMessage[];
  text?: string | string[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: "json_schema"; json_schema: object };
}

// POST /ai/run/<model>. Retries network errors, HTTP 429 and 5xx with capped
// exponential backoff. Returns the raw Response — the caller decodes either a
// JSON envelope or an SSE stream.
async function postRun(
  model: string,
  body: RunBody,
  attempts = 3,
): Promise<Response> {
  const { accountId, apiToken } = requireLlmCredentials();
  const url = `${API_BASE}/${accountId}/ai/run/${model}`;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const detail = await res.text().catch(() => "");
      if (retryable && i < attempts - 1) {
        await sleep(500 * 2 ** i);
        continue;
      }
      throw new WorkersAiError(
        `Workers AI ${model} returned HTTP ${res.status}: ${detail.slice(0, 300)}`,
        res.status,
      );
    } catch (err) {
      lastErr = err;
      // A WorkersAiError here is already final (non-retryable status, or the
      // last attempt) — propagate as-is. Anything else is a network/abort
      // error that is worth retrying.
      if (err instanceof WorkersAiError) throw err;
      if (i < attempts - 1) {
        await sleep(500 * 2 ** i);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

interface JsonEnvelope<T> {
  result: T;
  success: boolean;
  errors?: Array<{ code?: number; message: string }>;
}

async function decodeEnvelope<T>(res: Response, model: string): Promise<T> {
  const json = (await res.json()) as JsonEnvelope<T>;
  if (!json.success) {
    const msg =
      (json.errors ?? []).map((e) => e.message).join("; ") || "unknown error";
    throw new WorkersAiError(`Workers AI ${model} call failed: ${msg}`, 200);
  }
  return json.result;
}

export interface TextResult {
  text: string;
  usage: WorkersAiUsage;
}

// Non-streaming text generation.
export async function runText(opts: {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<TextResult> {
  const model = opts.model ?? llmConfig.answerModel;
  const res = await postRun(model, {
    messages: opts.messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  });
  const result = await decodeEnvelope<{ response?: string; usage?: unknown }>(
    res,
    model,
  );
  return {
    text: typeof result.response === "string" ? result.response : "",
    usage: parseUsage(result.usage),
  };
}

export interface JsonResult<T> {
  data: T;
  usage: WorkersAiUsage;
}

// JSON generation with a json_schema response format. Workers AI returns the
// payload already parsed when the schema is honoured, and as a JSON string
// otherwise — coerceJson handles both, plus a prose fallback.
export async function runJson<T>(opts: {
  model?: string;
  messages: ChatMessage[];
  schema: object;
  temperature?: number;
  maxTokens?: number;
}): Promise<JsonResult<T>> {
  const model = opts.model ?? llmConfig.candidateModel;
  const res = await postRun(model, {
    messages: opts.messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    response_format: { type: "json_schema", json_schema: opts.schema },
  });
  const result = await decodeEnvelope<{ response?: unknown; usage?: unknown }>(
    res,
    model,
  );
  return {
    data: coerceJson<T>(result.response, model),
    usage: parseUsage(result.usage),
  };
}

function coerceJson<T>(response: unknown, model: string): T {
  if (response && typeof response === "object") return response as T;
  const text =
    typeof response === "string" ? response : String(response ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) {
    throw new WorkersAiError(
      `Workers AI ${model} returned no JSON: ${text.slice(0, 200)}`,
      200,
    );
  }
  try {
    return JSON.parse(body.slice(start).trim()) as T;
  } catch {
    throw new WorkersAiError(
      `Workers AI ${model} returned malformed JSON: ${text.slice(0, 200)}`,
      200,
    );
  }
}

// Streaming text generation. Yields text deltas; the generator's return value
// is the final token usage (zero-filled when the stream omits a usage event).
export async function* runTextStream(opts: {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): AsyncGenerator<string, WorkersAiUsage, void> {
  const model = opts.model ?? llmConfig.answerModel;
  const res = await postRun(model, {
    messages: opts.messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: true,
  });
  if (!res.body) return ZERO_USAGE;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage = ZERO_USAGE;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const ev = parseSseEvent(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (ev?.usage) usage = ev.usage;
        if (ev?.text) yield ev.text;
        if (ev?.done) return usage;
      }
    }
    // Flush a trailing event that lacked the blank-line terminator.
    const tail = parseSseEvent(buf);
    if (tail?.usage) usage = tail.usage;
    if (tail?.text) yield tail.text;
  } finally {
    reader.releaseLock();
  }
  return usage;
}

function parseSseEvent(
  event: string,
): { text?: string; usage?: WorkersAiUsage; done?: boolean } | null {
  let payload = "";
  for (const line of event.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("data:")) payload += t.slice(5).trim();
  }
  if (!payload) return null;
  if (payload === "[DONE]") return { done: true };
  try {
    const obj = JSON.parse(payload) as { response?: string; usage?: unknown };
    return {
      text: typeof obj.response === "string" ? obj.response : undefined,
      usage: obj.usage ? parseUsage(obj.usage) : undefined,
    };
  } catch {
    return null;
  }
}

// Text embeddings. Returns one vector per input string, in input order.
export async function embed(
  texts: string[],
  model?: string,
): Promise<number[][]> {
  const m = model ?? llmConfig.embeddingModel;
  const res = await postRun(m, { text: texts });
  const result = await decodeEnvelope<{ data?: number[][] }>(res, m);
  if (!Array.isArray(result.data)) {
    throw new WorkersAiError(`Workers AI ${m} returned no embedding data`, 200);
  }
  return result.data;
}
