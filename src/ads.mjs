// The MOTD ad printed under the startup banner.
//
// CrawlProof's terminal format is *fetched*, not embedded: the endpoint returns
// a finished pure-ASCII box as text/plain, already wrapped to `cols`, so the
// pit only has to print it. Everything here is best-effort and silent — a slow
// or unreachable ad server must never delay or dirty the prompt.
const AD_ENDPOINT = "https://crawlproof.com/api/ads/motd";
const SLOT = "a138e9c5-4b7d-4eaa-8b2d-cb3a2dd9382f";
// 76, not 72. The click URL carries `?s=moshcode` and runs 71 chars, which
// can't fit inside a 72-wide box — the renderer then drops it below the
// footer as a dangling line. 76 keeps it on one line inside the box and still
// fits an 80-column terminal. Override with MOSHCODE_AD_COLS if you must.
const COLS = Number(process.env.MOSHCODE_AD_COLS) || 76;
const TIMEOUT_MS = 1500;

/**
 * Fetch the MOTD block. Resolves to the text to print, or null when it's
 * disabled, unavailable, or doesn't look like the box we asked for.
 *
 * Kick this off BEFORE rendering the banner and await it after: the startup
 * text takes long enough to print that the ad usually costs no visible time.
 */
export async function fetchMotdAd({ cols = COLS, timeoutMs = TIMEOUT_MS, signal } = {}) {
  if (process.env.MOSHCODE_NO_ADS) return null;
  const url = `${AD_ENDPOINT}?slot=${encodeURIComponent(SLOT)}&cols=${cols}&src=moshcode`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  signal?.addEventListener?.("abort", () => abort.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { accept: "text/plain" } });
    if (!res.ok) return null;
    const body = await res.text();
    return sanitizeAd(body, cols);
  } catch {
    return null; // offline, slow, blocked — the pit opens either way
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip anything that could repaint the terminal and drop lines wider than the
 * box we asked for. The server sanitizes too, but this is the last gate before
 * untrusted advertiser copy reaches someone's screen — an escape sequence here
 * could move the cursor, clear the display, or hide what the pit prints next.
 */
export function sanitizeAd(text, cols = COLS) {
  if (typeof text !== "string") return null;
  const lines = text
    .split("\n")
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trimEnd())
    .filter((line, i, arr) => !(line === "" && (i === 0 || i === arr.length - 1)));
  if (!lines.length) return null;
  if (lines.some((line) => line.length > cols + 8)) return null; // not the box we asked for
  const out = lines.join("\n").trim();
  return out || null;
}
