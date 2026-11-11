// /privacy and /terms: server-rendered, public, in the brand shell.
import { Router } from "express";
import { page, footer } from "../lib/html.mjs";
import { ringFooter } from "../lib/ring-footer.mjs";
import { LEGAL_EFFECTIVE, PRIVACY_HTML, TERMS_HTML } from "../lib/legal.mjs";

export const legalRouter = Router();

const LEGAL_CSS = `<style>
.legal{max-width:760px;padding-top:40px}
.legal h1{font-size:2rem;margin:6px 0 4px}
.legal h2{font-size:1.05rem;margin:30px 0 8px}
.legal p,.legal li{color:var(--dim)}
.legal b{color:var(--text)}
.legal a{color:var(--acid)}
.legal code{font-family:var(--mono);font-size:.85em;word-break:break-all}
</style>`;

function legalPage(title, other, html) {
  const body = `
  <main class="wrap legal">
    <a class="brand" href="/"><span class="mark">M</span>MOSHCODE<span class="app">app</span></a>
    <h1>${title}</h1>
    <p class="label">Effective date: ${LEGAL_EFFECTIVE} · ${other}</p>
    ${html}
  </main>${footer}
  <div class="wrap">${ringFooter()}</div>`;
  return page({ title: `${title} · moshcode`, head: LEGAL_CSS, body });
}

legalRouter.get(["/privacy", "/privacy/"], (_req, res) => {
  res.type("html").send(legalPage("Privacy Policy", `<a href="/terms">Terms of Service</a>`, PRIVACY_HTML));
});

legalRouter.get(["/terms", "/terms/"], (_req, res) => {
  res.type("html").send(legalPage("Terms of Service", `<a href="/privacy">Privacy Policy</a>`, TERMS_HTML));
});
