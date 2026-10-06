// Engines that are an HTTP API and nothing else.
//
// Every entry in ENGINES (src/engines.mjs) is a CLI moshcode can install,
// launch, hand a terminal to and read the screen of. These are not: Z.AI's GLM,
// Perplexity's Sonar and Sakana's Fugu are OpenAI-compatible Chat Completions
// endpoints with no terminal program of their own. So they live in their own
// table, `kind: "api"`, rather than in ENGINES with the install/launch/herd
// fields left blank — every loop over ENGINES (install, upgrade, the herd, the
// skill and plugin summaries) would otherwise have to learn to skip them, and
// the first one that forgot would spawn `undefined`.
//
// What they can do is the one-shot path: `moshcode oneshot <engine> "<prompt>"`,
// moshscript's `ai(prompt, { engine })` and `moshcode hooks serve`. What they
// cannot do is open an interactive session, and every launch surface says so
// in a sentence (see `interactiveError`) rather than crashing on a missing bin.
//
// Defaults match what crawlproof.com calls (lib/audit/{zai,perplexity,fugu}-
// engine.ts); each base URL and model is overridable from the environment.
// Plain fetch, no SDK: one POST to /chat/completions is the whole protocol.

export const API_ENGINES = {
  zai: {
    kind: "api",
    desc: "Z.AI GLM — Zhipu's GLM models over the OpenAI-compatible API (API only)",
    // The GLM Coding Plan endpoint: it bills against the monthly plan rather
    // than the pay-as-you-go balance the standard /api/paas/v4 endpoint needs.
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    model: "glm-5.2",
    keyEnv: "ZAI_API_KEY",
    baseUrlEnv: "ZAI_BASE_URL",
    modelEnv: "ZAI_MODEL",
  },
  perplexity: {
    kind: "api",
    desc: "Perplexity Sonar — web-grounded answers over the OpenAI-compatible API (API only)",
    baseUrl: "https://api.perplexity.ai",
    model: "sonar-reasoning-pro",
    keyEnv: "PERPLEXITY_API_KEY",
    baseUrlEnv: "PERPLEXITY_BASE_URL",
    modelEnv: "PERPLEXITY_MODEL",
  },
  fugu: {
    kind: "api",
    desc: "Sakana Fugu — an orchestration model routing across frontier LLMs (API only)",
    // "fugu-ultra" is the higher tier; FUGU_MODEL picks it.
    baseUrl: "https://api.sakana.ai/v1",
    model: "fugu",
    keyEnv: "FUGU_API_KEY",
    baseUrlEnv: "FUGU_BASE_URL",
    modelEnv: "FUGU_MODEL",
  },
};

export const API_ENGINE_ALIASES = {
  glm: "zai", "z.ai": "zai", zhipu: "zai",
  pplx: "perplexity", sonar: "perplexity",
  sakana: "fugu",
};

/** Default output budget. Overridable per engine with <KEY>_MAX_TOKENS. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Resolve a name/alias to `[key, engine]` among the API engines, or null. */
export function resolveApiEngine(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  const key = Object.hasOwn(API_ENGINES, t) ? t : Object.hasOwn(API_ENGINE_ALIASES, t) ? API_ENGINE_ALIASES[t] : null;
  return key ? [key, API_ENGINES[key]] : null;
}

const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The effective config for one API engine: env overrides over the defaults. */
export function apiEngineConfig(key, env = process.env) {
  const spec = API_ENGINES[key];
  if (!spec) throw new Error(`unknown API engine "${key}"`);
  const maxTokens = Number(env[`${key.toUpperCase()}_MAX_TOKENS`]);
  return {
    key,
    baseUrl: (nonEmpty(env[spec.baseUrlEnv]) || spec.baseUrl).replace(/\/+$/, ""),
    model: nonEmpty(env[spec.modelEnv]) || spec.model,
    apiKey: nonEmpty(env[spec.keyEnv]),
    keyEnv: spec.keyEnv,
    maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

/** Is this API engine usable here? An API engine is "installed" when its key is set. */
export function apiEngineAvailable(key, env = process.env) {
  const cfg = apiEngineConfig(key, env);
  return cfg.apiKey ? { available: true } : { available: false, reason: `${cfg.keyEnv} is not set` };
}

/** The sentence every interactive launch surface prints for an API engine. */
export function interactiveError(key) {
  return `${key} is an API-only engine: it has no interactive session to open. `
    + `run one prompt with: moshcode oneshot ${key} "<prompt>"`;
}

/**
 * The request one prompt becomes. Pure, so the shape is tested without a
 * network: POST <base>/chat/completions, Bearer auth, one user message.
 */
export function buildChatRequest(cfg, prompt) {
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: String(prompt) }],
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
    },
  };
}

/**
 * Drop a reasoning model's visible chain of thought.
 *
 * sonar-reasoning-pro (and GLM in thinking mode) put `<think>…</think>` ahead
 * of the answer, in the content itself. An unterminated block — the model ran
 * out of tokens mid-thought — is dropped to the end, because what follows an
 * unclosed <think> is still thinking, not an answer.
 */
export function stripThink(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/** Text out of a chat-completions response body, whatever shape content takes. */
function contentOf(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  // Some providers send content parts: [{ type: "text", text }].
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return null;
}

/**
 * Run one prompt on one API engine. Never throws for an engine failure: it
 * answers `{ ok, output, error, model, status, ms }`, the same shape a CLI
 * one-shot answers, because the fan-out runner reports both the same way.
 * The API key never appears in an error.
 */
export async function runApiEngine(key, prompt, {
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  signal,
} = {}) {
  const started = Date.now();
  const cfg = apiEngineConfig(key, env);
  const done = (r) => ({ model: cfg.model, ms: Date.now() - started, ...r });
  if (!cfg.apiKey) return done({ ok: false, output: "", error: `${cfg.keyEnv} is not set`, status: null });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const { url, init } = buildChatRequest(cfg, prompt);
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* reported below */ }
    if (!res.ok) {
      const detail = body?.error?.message || body?.message || text.slice(0, 300);
      return done({ ok: false, output: "", error: `HTTP ${res.status}${detail ? `: ${String(detail).trim()}` : ""}`, status: res.status });
    }
    const content = contentOf(body);
    if (content == null) return done({ ok: false, output: "", error: "response carried no choices[0].message.content", status: res.status });
    return done({ ok: true, output: stripThink(content), error: null, status: res.status, model: body?.model || cfg.model });
  } catch (e) {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    return done({ ok: false, output: "", error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e)), status: null });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}
