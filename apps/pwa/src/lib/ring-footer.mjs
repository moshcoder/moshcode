// The Profullstack footer (links, copyright, the << Profullstack >> webring row and
// the built.indie + pwamart badges) from @profullstack/footer, on the public
// sign-in page. It is rendered into the HTML on the server because rssamplifier's
// ring verifier reads the page and never runs script.
//
// Pages render synchronously, so the footer is kept as a string: the bundled
// template at boot, then the @latest template from the CDN, refreshed every 15
// minutes (a footer release reaches us with no redeploy). A failed refresh keeps
// the last good copy. app.moshcode.sh is an ICANN host: clearnet template only.
import { footerHtml, footerHtmlSync } from "@profullstack/footer";

export const RING_FOOTER_OPTIONS = {
  site: "https://app.moshcode.sh/",
  builtIndieHref: "https://built.indie.pit.world/for?site=https://app.moshcode.sh/",
  pwamartHref: "https://pwamart.com/for?site=https://app.moshcode.sh/",
  links: [
    { label: "moshcode.sh", href: "https://moshcode.sh/" },
    { label: "The pit", href: "/pit" },
  ],
};

let html = footerHtmlSync(RING_FOOTER_OPTIONS);

/** The footer markup; never empty. */
export function ringFooter() {
  return html;
}

/** Accept a rendered footer only when it still links the ring. */
export function setRingFooter(next) {
  if (typeof next !== "string" || !next.includes("/ring/profullstack") || next.length > 64_000) return false;
  html = next;
  return true;
}

export function startRingFooterRefresh(everyMs = 15 * 60_000) {
  if (process.env.PROFULLSTACK_FOOTER_OFFLINE === "1") return () => {};
  const run = () => { footerHtml(RING_FOOTER_OPTIONS).then(setRingFooter, () => {}); };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
