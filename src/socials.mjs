import { canOpenBrowser, openBrowser } from "./open-url.mjs";

const DEFAULT_APP = "https://app.moshcode.sh";

export const SOCIALS = [
  {
    name: "bluesky",
    aliases: ["bsky"],
    description: "official Bluesky browser composer",
  },
  {
    name: "nostr",
    aliases: [],
    description: "NIP-07/NIP-46 browser signer + relay publish",
  },
];

export function resolveSocial(name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  return SOCIALS.find((social) =>
    social.name === wanted || social.aliases.includes(wanted)) ?? null;
}

function appOrigin(env = process.env) {
  return String(env.MOSHCODE_API || DEFAULT_APP).replace(/\/+$/, "");
}

/**
 * Build the browser hand-off without opening anything. Nostr keeps the draft
 * in the fragment so it never reaches app.moshcode.sh access logs or Referer
 * headers; the composer reads it entirely in the browser.
 */
export function socialPostUrl(name, message, { env = process.env } = {}) {
  const social = resolveSocial(name);
  if (!social) return null;
  const text = String(message ?? "");
  if (social.name === "bluesky") {
    return `https://bsky.app/intent/compose?${new URLSearchParams({ text })}`;
  }
  return `${appOrigin(env)}/socials/nostr#${new URLSearchParams({ text })}`;
}

export function socialRoster() {
  return SOCIALS.map((social) => ({ ...social, aliases: [...social.aliases] }));
}

/**
 * Open a provider composer. Posting remains an explicit browser confirmation:
 * Bluesky requires it, and Nostr asks the browser signer before relay publish.
 */
export function postSocial(args, {
  env = process.env,
  canOpen = canOpenBrowser,
  open = openBrowser,
} = {}) {
  const [requested, ...words] = Array.isArray(args) ? args : [];
  const social = resolveSocial(requested);
  if (!requested) return { ok: false, error: 'usage: /post <social> "message"' };
  if (!social) {
    return {
      ok: false,
      error: `unknown social "${requested}". try: ${SOCIALS.map((entry) => entry.name).join(", ")}`,
    };
  }

  const message = words.join(" ").trim();
  if (!message) return { ok: false, error: 'usage: /post <social> "message"' };

  const url = socialPostUrl(social.name, message, { env });
  const opened = Boolean(canOpen() && open(url));
  return { ok: true, social: social.name, message, url, opened };
}
