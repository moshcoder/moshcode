# PRDs

Product requirements documents for this repo, following the
[OpenPRD](https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md)
standard — a numbered, committed proposal collection (like a BIP/EIP/DIP
process).

Each PRD is one file: `NNNN-slug.md`. `0000-template.md` is the template.
Lifecycle: **Draft → Review → Accepted → Final** (or Rejected / Withdrawn /
Superseded). Status lives in each file's front matter.

Start one with `moshcode prd "<idea>"` (TUI: `/prd`).

## Index

<!-- PRD-INDEX:START -->
| # | Title | Status |
|---|---|---|
| [0001](0001-wrap-ugig-and-coinpay-clis.md) | Wrap the UGig and CoinPay CLIs | Accepted |
| [0002](0002-separate-agent-and-raw-engine-launches.md) | Separate autonomous agent and raw engine launches | Accepted |
| [0003](0003-cross-engine-mcp-and-skill-installation.md) | Install MCP servers and skills across every engine at once | Accepted |
| [0004](0004-moshscript-run-programmable-moshcode.md) | moshscript — a scriptable /run for driving all of moshcode programmatically | Accepted |
| [0005](0005-hosted-moshpit-resolver.md) | A hosted Moshpit resolver, for the devices that cannot run the bridge | Draft |
| [0006](0006-help.md) | --help | Draft |
| [0007](0007-profullstack-site-init.md) | Generate batteries-included Profullstack sites for Moshpit names | Draft |
| [0008](0008-ticker-research-and-plugin-marketplace.md) | Bring equity research into the pit, and ship the pit's slash commands as a plugin | Draft |
| [0009](0009-persistent-agent-runtime.md) | Keep the herd alive — a persistent runtime, semantic agent state, and one control surface for humans and agents | Accepted |
| [0010](0010-cloud-settings-sync.md) | Sync the pit's settings to your moshcode.sh account | Draft |
| [0011](0011-herd-agent-protocol.md) | Teach the herd the agent protocol — hooks-first state, a task ledger, and an A2A surface for local and remote agents | Draft |
<!-- PRD-INDEX:END -->
