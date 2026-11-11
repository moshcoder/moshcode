// Privacy Policy and Terms of Service for the moshcode product: moshcode.sh
// (the landing), app.moshcode.sh (this app, including the pit) and its MCP.
// The landing serves the same text (moshcode/moshcode.sh src/legal.mjs); keep
// the two copies in step.

export const LEGAL_EFFECTIVE = "November 11, 2026";
const CONTACT = "support@profullstack.com";
const OPERATOR = "Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA";
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

export const PRIVACY_HTML = `
<p>moshcode is operated by ${OPERATOR}. This policy covers moshcode.sh, app.moshcode.sh (including the pit and the Moshpit name registry), the moshcode MCP server, and what the moshcode CLI sends to them. It describes only what the service actually collects.</p>

<h2>The CLI runs on your machine</h2>
<p>The moshcode CLI installs and drives coding agents (opencode, Claude Code, codex and others) on your own computer. Your code, prompts and the agents' own accounts stay between you and those tools. The CLI sends something to app.moshcode.sh only when you use a feature that needs it: an approval, a live session mirror, the herd on your phone, settings sync, or the pit.</p>

<h2>What we collect</h2>
<p><b>Account.</b> Your email address and a password (stored only as a hash), or a passkey (we keep its public key and a counter), or Sign in with CoinPay (we keep the CoinPay account identifier). An optional display name. A session cookie while you are signed in. API keys and CLI sign-ins are stored as hashes with a short prefix.</p>
<p><b>Approvals.</b> When a script asks for one, we store its message, the context the script sent, the script name, and your reply.</p>
<p><b>Notification channels.</b> The channels you add: an email address, a Slack incoming webhook URL, a Telegram chat id, browser push subscriptions, or a phone number for SMS.</p>
<p><b>Live sessions and the herd.</b> If you mirror a CLI session or turn on the herd for your phone, the CLI sends the terminal output of that session (we keep the most recent part as scrollback), the session and machine names, and their status, and we queue the lines and keys you send back until the CLI collects them.</p>
<p><b>Teams.</b> Organizations, teams and members you create, and the sessions you share with them.</p>
<p><b>Settings sync.</b> The settings snapshots you save from the pit with <code>/save</code>; you can delete them from your settings.</p>
<p><b>Credits and payments.</b> Credits are prepaid in cryptocurrency through CoinPay. We keep a ledger of credits bought and spent, purchase amounts and status, credit codes you redeem and invites you send. We never see card or bank details.</p>
<p><b>Moshpit names.</b> Names and endings you register or buy, their records (addresses, sites, links, feeds and content you publish to them), and offers. If you opt in to a contact address for a name, mail to it is forwarded to you through Forward Email without publishing your own address.</p>

<h2>Cookies and local storage</h2>
<p>Signing in sets a session cookie, and forms carry a CSRF token. An invite or referral link sets a cookie so a later sign-up can be credited. There are no advertising cookies.</p>

<h2>Who else is involved</h2>
<ul>
<li><b>CoinPay</b> (coinpayportal.com): credit and name purchases, and the optional Sign in with CoinPay. On moshcode.sh, crawlers that buy a day pass pay through CoinPay or x402.</li>
<li><b>Resend</b>: delivers approval, invite and Moshpit offer email, so it processes your email address.</li>
<li><b>Slack and Telegram</b>: approvals sent to the webhook or chat you configured; their own policies apply.</li>
<li><b>Your browser's push service</b>: delivers push notifications.</li>
<li><b>Forward Email</b>: forwards mail sent to a Moshpit name's contact address, if you turned one on.</li>
<li><b>CrawlProof</b> (crawlproof.com): a stats script for aggregate page analytics on moshcode.sh and on the public pit pages; and on moshcode.sh's inner pages, one small text ad served in a frame from crawlproof.com. The signed-in app is not counted.</li>
<li><b>jsDelivr</b>: serves the WebMCP script on moshcode.sh.</li>
</ul>
<p>Nothing is sold, and no advertising profile is built from you.</p>

<h2>What is public</h2>
<p>Registered Moshpit names, their records and anything you publish to them are public. Approvals, sessions, settings, channels and payments are visible only to your account and the teams you share them with.</p>

<h2>AI agents and MCP</h2>
<p>The moshcode MCP server is at <code>https://app.moshcode.sh/mcp</code> (JSON-RPC 2.0, streamable HTTP), and a single shared session is reachable at <code>https://moshcode.sh/api/v1/mcp/&lt;share-id&gt;</code>. There are no anonymous tools: every call needs an OAuth 2.1 access token (authorization code with PKCE, or device authorization) that you approve in the browser. With it, an MCP client can list your live moshcode sessions, read their output, and, only with the permissions you grant, send a line or a key, answer or approve a prompt, or cancel the session. Access tokens last at most an hour, and revoking the grant or the share stops them at once.</p>
<p>MCP and API requests are logged (time, tool or route, IP address, and the account or key if any) for abuse prevention and rate limiting. MCP actions are also recorded in an audit log of who did what and when, without the command text or terminal output. No MCP data is sold or used for advertising.</p>

<h2>Keeping and deleting data</h2>
<p>Session output is kept as a rolling scrollback, not a full history. Settings snapshots can be deleted from your settings. Everything else is kept until you delete it or ask us to. To delete your account, write to ${mail} from the address on the account.</p>

<h2>Your rights</h2>
<p>Depending on where you live, you may have the right to access, correct, delete or export your personal data. Contact us to exercise them.</p>

<h2>Children</h2>
<p>moshcode is a developer tool and is not directed at children under 13, and we do not knowingly collect personal information from them.</p>

<h2>Changes</h2>
<p>If the service starts doing something different, this page changes with it. Material changes will be announced on this page.</p>

<h2>Contact</h2>
<p>${OPERATOR}. Email ${mail}.</p>`;

export const TERMS_HTML = `
<h2>1. Acceptance of terms</h2>
<p>By accessing or using moshcode.sh, app.moshcode.sh, the moshcode CLI's online features or the moshcode MCP server (the "Service"), you agree to these Terms of Service. If you do not agree, do not use the Service. The Service is operated by ${OPERATOR}.</p>

<h2>2. Use of the Service</h2>
<p>moshcode drives coding agents, routes approvals to you, mirrors your sessions and runs the Moshpit name registry. You are responsible for what your agents and scripts do with it. Do not use the Service to attack, spam or harm others, to publish illegal content on a Moshpit name, or to get around access controls. Please do not send automated traffic heavy enough to degrade the Service for anyone else; on moshcode.sh, training crawlers and scrapers must buy a day pass.</p>

<h2>3. Accounts</h2>
<p>You are responsible for your account, API keys, OAuth grants and session shares, and all activity under them. Tell us at once about any unauthorized use.</p>

<h2>4. Payments</h2>
<p>Credits, Moshpit names and crawler day passes are paid in cryptocurrency through CoinPay, or over x402. Credits pay for metered notification channels as they are used.</p>

<h2>5. Your content</h2>
<p>You keep whatever rights you have in what you send, share or publish, and you confirm you may share it. You give us permission to store, process and show it as needed to run the Service.</p>

<h2>6. MCP and API use</h2>
<p>The MCP server at <code>https://app.moshcode.sh/mcp</code>, shared session endpoints and the API are part of the Service and fall under these terms, including the acceptable use rules above. An agent acting with a grant you approved acts on your behalf, and you are responsible for what it does. A grant with write access can type into your terminal session; grant only what you mean to.</p>

<h2>7. Intellectual property</h2>
<p>All content, code and trademarks associated with moshcode are the property of Profullstack, Inc. or its licensors. moshcode's source code is available under the MIT License, and open-source components are governed by their respective licenses.</p>

<h2>8. Disclaimer of warranties</h2>
<p>The Service is provided "as is" without warranties of any kind. We do not guarantee that it will be uninterrupted, secure or error-free.</p>

<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any indirect, incidental, special, consequential or punitive damages arising out of your use of the Service.</p>

<h2>10. Changes to terms</h2>
<p>We may update these terms from time to time. Continued use of the Service after a change means you accept the revised terms.</p>

<h2>11. Contact</h2>
<p>Questions about these terms? Email ${mail}.</p>`;
