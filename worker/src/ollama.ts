import { env } from './env.ts';

/** Kept the name for backwards-compat; this is the LLM client for whatever provider is configured. */
export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface GenerateOptions {
  prompt: string;
  system?: string;
  temperature?: number;
  numCtx?: number;
  /** Ollama structured-output schema (JSON Schema). OpenAI path just uses json_object mode. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const useOpenAI = env.llm.provider === 'openai';

/** Human label for the active backend, for logs / doctor. */
export const llmLabel = useOpenAI
  ? `${env.llm.model || '?'} @ ${hostOf(env.llm.baseUrl)}`
  : `${env.ollama.model} @ ollama`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || 'unset';
  }
}

/** Ask the model for a JSON answer and parse it. Retries once on a transient failure. */
export async function generateJSON<T>(opts: GenerateOptions): Promise<T> {
  return useOpenAI ? viaOpenAI<T>(opts) : viaOllama<T>(opts);
}

// --- Ollama (local) ------------------------------------------------------

interface OllamaResponse {
  response: string;
}

async function viaOllama<T>(opts: GenerateOptions): Promise<T> {
  const body = {
    model: env.ollama.model,
    prompt: opts.prompt,
    system: opts.system,
    stream: false,
    format: opts.schema ?? 'json',
    options: { temperature: opts.temperature ?? 0.2, num_ctx: opts.numCtx ?? 8192 },
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { res, done } = await fetchWithTimeout(`${env.ollama.url}/api/generate`, body, undefined, opts);
      try {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 404) {
            throw new OllamaError(`Model "${env.ollama.model}" is not in Ollama.`, `Run: ollama pull ${env.ollama.model}`);
          }
          throw new OllamaError(`Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as OllamaResponse;
        return JSON.parse(data.response) as T;
      } finally {
        done();
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof OllamaError) throw err;
      if (opts.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new OllamaError(
    `Could not reach Ollama at ${env.ollama.url} (${(lastErr as Error)?.message ?? 'unknown error'}).`,
    'Is it running? macOS: brew services start ollama · Linux: sudo systemctl start ollama',
  );
}

// --- OpenAI-compatible (Gemini free tier / Groq / Cerebras / …) ---------

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function viaOpenAI<T>(opts: GenerateOptions): Promise<T> {
  if (!env.llm.baseUrl || !env.llm.apiKey || !env.llm.model) {
    throw new OllamaError(
      'LLM_PROVIDER=openai but LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are not all set.',
      'See CLOUD.md — e.g. Gemini free tier: LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai',
    );
  }
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    { role: 'user', content: opts.prompt },
  ];
  const body = {
    model: env.llm.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    response_format: { type: 'json_object' },
  };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.llm.apiKey}` };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { res, done } = await fetchWithTimeout(`${env.llm.baseUrl}/chat/completions`, body, headers, opts);
      try {
        const data = (await res.json().catch(() => ({}))) as ChatResponse;
        if (!res.ok) {
          const msg = data.error?.message ?? `HTTP ${res.status}`;
          // 429 = rate limit; back off and retry
          if (res.status === 429 || res.status >= 500) throw new Error(msg);
          throw new OllamaError(`LLM API error: ${msg}`, res.status === 401 ? 'Check LLM_API_KEY.' : undefined);
        }
        const content = data.choices?.[0]?.message?.content ?? '';
        return JSON.parse(stripFence(content)) as T;
      } finally {
        done();
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof OllamaError) throw err;
      if (opts.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw new OllamaError(`LLM request failed after retries (${(lastErr as Error)?.message ?? 'unknown'}).`);
}

// --- shared ------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  body: unknown,
  headers: Record<string, string> | undefined,
  opts: GenerateOptions,
): Promise<{ res: Response; done: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const res = await fetch(url, {
    method: 'POST',
    headers: headers ?? { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  return {
    res,
    done: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Some providers wrap JSON in ```json fences despite json_object mode. */
function stripFence(s: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  return (m ? m[1]! : s).trim();
}
