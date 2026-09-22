---
openprd: "0.3"
id: "0017"
title: "Put the herd on the Omarchy bar — a plugin, and the one snapshot it reads"
status: Accepted
authors:
  - anthony@profullstack.com
created: 2026-09-22
updated: 2026-09-22
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/omarchy.mjs, omarchy/, test/omarchy.test.mjs, bin/moshcode.mjs, src/cli-schema.mjs
tags:
  - omarchy
  - herd
  - fleet
  - cost
  - plugin
supersedes:
superseded-by:
---

## Problem

Everything moshcode knows about a running fleet is behind a prompt. `moshcode ps` says which agents are alive, `moshcode cost --all` says what they are burning, `moshcode fleet tree` says who started whom. All three are true and none of them are on screen. You learn what your machine is doing by deciding to ask.

That gap has already cost real money and real hours. On 2026-09-13 the burn turned out to be a dozen parallel background jobs running at roughly $131/hour at list, which nobody saw until someone typed `moshcode cost`. The cheaper and more common version is an agent in `blocked` state: it asked a question twenty minutes ago, it is holding a pane and a context window, and the only evidence is a line of text in a session nobody is looking at. A number that is only true when you ask for it is not a status; it is a lookup.

Omarchy ships a Quickshell bar with a documented third-party plugin surface (`plugins.omarchy.org/develop.html`): a `bar-widget` is a QML item that lives in the active bar, a `panel` is a floating surface it can summon, both installed from a git URL into `~/.config/omarchy/plugins/{id}` and both reloaded on rescan. That is exactly the shape of the missing surface: one persistent glyph that is always visible, and a list you open when the glyph says something changed. The marketplace currently lists zero community plugins, so a small well-behaved one lands in an empty room.

There is a cost to getting it wrong. Omarchy plugins run **unsandboxed, inside a shared long-running shell process, with the user's permissions**, and the documentation is blunt about it: "Review every dependency and command, avoid unnecessary privileges, and never start a second Quickshell process for a plugin." A widget that leaks a process per tick or throws on a parse error does not break moshcode, it breaks the whole bar for everyone who installed it. That constraint, not the QML, is what shapes this PRD.

## Goals

- The state of the herd — how many agents are running, waiting, blocked, and what the last hour cost — is on screen without anyone asking for it.
- A blocked agent is noticed in seconds, because the thing that changed is the one glyph that is always visible.
- moshcode stays the only source of truth. The plugin renders a snapshot the CLI produced; it never computes fleet state itself, and it never becomes a second control plane.
- One cheap read. The bar polls a single command, one process at a time, bounded and read-only, at a cadence honest about what a process costs.
- Installable by a stranger in one command, listed in the Omarchy marketplace, and removable without leaving anything behind.
- Honest when it cannot know. No moshcode, a stale snapshot, or an engine that prices nothing all read as themselves, never as zero.

## Non-Goals

- A control plane on the bar. Starting agents, writing prompts, and answering a blocked question stay in the terminal, the TUI, and `moshcode herd`.
- Replacing `moshcode herd bar` (the tmux row under a session) or the TUI. This is a third surface for a different moment: you are not in moshcode, and you want to know whether you should be.
- Ports to Waybar, Ironbar, GNOME, or anything else in 0.1. One bar, done properly.
- A daemon, a socket, or a network. The plugin spawns the CLI and reads stdout.
- Support for the `bar`, `overlay`, `menu` or `service` kinds. `bar-widget` plus `panel` is the whole surface for 0.1 (`service` is revisited under Open Questions).
- Changing what moshcode already records. This reads `ps`, `cost` and `fleet tree`; it does not add fields to the herd manifest or to OpenFleet (PRD 0016).

## Users

- The operator running several agents at once on an Omarchy box, who currently learns the fleet state by typing and therefore learns it late.
- The moshcode user on Omarchy who never opens the TUI, and for whom the bar is the only moshcode surface they will see all day.
- An Omarchy user with no moshcode installed, who sees the listing and needs the plugin to say so plainly rather than render an empty bar item.

## Requirements

- R1 [P0] `moshcode omarchy status --json` is the only thing the plugin runs. One process, no shell, no arguments the plugin composes from user data. It prints one object: `schema` (integer, 1), `generatedAt` (ISO 8601), `moshcode` (version), `agents` (the `ps --json` rows, already carrying `name`, `engine`, `state`, `fleet`, `swarm`, `approvals`, `cwd`, `ageMs`, `alive`, `attached`), `counts` (`running`, `waiting`, `blocked`, `gone`), `burn` (the `1m`, `15m`, `1h` windows from `cost --json` with `cost`, `perHour`, `runs`, `engines`, `unpriced`), `fleets` (the `fleet tree --json` roots, one level deep), and `alerts` (zero or more `{ kind, subject, since }`). It exits 0 with a populated object or exits 0 with `{ schema, generatedAt, error }`; it never writes to the herd, the ledger, or the fleet.
- R2 [P0] The snapshot is bounded, and the bound is on the work, not on the wall clock (the wall clock belongs to node's start-up). `omarchy status` reads the roster, the fleets and the cost in one process, and caches the cost half for `--ttl` (default 5s) under `~/.moshcode/herd/omarchy-status.json` (0600); a reading that took longer than 2s marks itself `slow` and is held for a minute instead, because paying two seconds every five for a number that moves by cents is the wrong trade. A cost reading that throws serves the last good one and marks the snapshot `partial`. Measured at implementation: roster 215ms, fleets 1ms, cost 5ms on a cache hit.
- R3 [P0] The plugin lives in its own public repository, `moshcoder/omarchy-moshcode`, because `omarchy plugin add {git-url}` clones a repo into `~/.config/omarchy/plugins/{id}` and validation requires `manifest.json` at the repository root. Contents: `manifest.json`, `BarWidget.qml`, `Panel.qml`, `Model.js`, `preview.png`, `README.md`, `LICENSE` (MIT), and no symlinks anywhere, which the CLI validator rejects.
- R4 [P0] The manifest is `schemaVersion: 1`, `id: "sh.moshcode.herd"` (namespaced, and not under the reserved `omarchy.*` prefix), `name: "Moshcode Herd"`, `version` semver, `author`, `license: "MIT"`, `description`, `kinds: ["bar-widget", "panel"]`, `entryPoints: { "barWidget": "BarWidget.qml", "panel": "Panel.qml" }`, and a `barWidget` block with `displayName`, `category: "System"`, `allowMultiple: false`, `defaultSection: "right"`. `BarWidget.qml` and `Panel.qml` share one `moduleName`, which is required for the widget to load the panel through a `Loader`.
- R5 [P0] The widget is one line and it is theme-driven: agent count, a state glyph, and `$/h` from the `1h` window when it is above a configurable floor (default $1/hour, so an idle machine shows no money). Colors come from `root.barForeground` and the shell's theme properties and the font from `root.bar.fontFamily`. No hard-coded color, no hard-coded font, no icon that only reads on a dark theme.
- R6 [P0] The panel is a list, not a dashboard: one row per agent (name, engine, state, fleet/swarm, age, cwd tail, and a marker when `approvals` is `bypass`), then the three burn windows with cost and cost per hour, then the snapshot's age. It exposes `open()`, `close()`, `toggle()`, the `opened` and `popoutSwitchClosing` properties the shell expects, anchors with `KeyboardPanel`, and handles Escape and Tab through `PanelKeyCatcher`.
- R7 [P0] Polling is one `Process` at a time, started on a timer, never overlapping: 10s while the panel is closed, 3s while it is open, and a back-off to 60s after three consecutive failures, recovering on the first success. **Revised during implementation.** The first draft said 5s and 1s, on the strength of a 210ms reading of `moshcode ps --json`. Measured properly, a `moshcode` process costs 0.66s to 4.2s on a box busy running the agents it reports on, and almost all of that is node's start-up plus the CLI's — `moshcode omarchy validate`, which reads one manifest, costs the same. A one-second poll would spend a visible slice of a core reporting how busy the machine is. No `sh -c`, no string interpolation into a command line, no second Quickshell process, and every parse wrapped so that malformed JSON renders as "unavailable" instead of throwing into the shared shell.
- R8 [P0] The plugin is read-only in 0.1. The only state it changes is its own panel through `summon`/`hide`. It never starts, stops, kills, or attaches anything.
- R9 [P0] It degrades honestly. No `moshcode` on PATH reads "moshcode not installed" with an install hint in the panel, not zeros. A snapshot older than three poll intervals dims the widget and shows its timestamp. Engines that log nothing priceable (gemini, kimi, deepseek, openagents) are carried through from `cost`'s `unpriced` and named in the panel, so an unpriced fleet never renders as free. A moshcode too old to have `omarchy status` reads "moshcode 0.x is too old" with the version it needs.
- R10 [P0] Blocked is the alert. Any agent in `blocked` state — a question, not a finish — puts the widget into its attention state (theme accent, blocked count first) and raises an `alerts` entry with the subject and how long it has been waiting. This is the single behaviour the whole plugin exists for; everything else is context around it.
- R11 [P0] `moshcode omarchy validate [dir]` reproduces the documented CLI checks in JavaScript, so the plugin can be verified on a box with no Omarchy installed: manifest parses as JSON, the seven required fields are present, every declared kind has its matching entry point key, every referenced file exists as a safe relative path inside the plugin directory, there are no symlinks, and the id is not in the `omarchy.*` namespace. It runs in the plugin repository's CI on every push, and it is not a claim that the plugin works — only that the listing will validate.
- R12 [P1] `moshcode omarchy install [--link]` clones or symlinks the plugin into `~/.config/omarchy/plugins/sh.moshcode.herd` and runs `omarchy-shell shell rescanPlugins`; `--link` is the development path and is refused when the target is not a moshcode checkout. `moshcode omarchy doctor` reports what is present: `omarchy`, `omarchy-shell`, `qmllint`, `$OMARCHY_PATH/shell`, the plugin directory, and the installed plugin version against the CLI's.
- R13 [P0] Before submission the plugin is verified on a real Omarchy install, not on the dev box: `omarchy plugin validate "$PLUGIN_DIR"` clean, `qmllint -I "$OMARCHY_PATH/shell"` clean on both QML files, the widget renders in all three sections (`omarchy bar move sh.moshcode.herd --section left|center|right`), the panel opens and closes from the keyboard, the shell survives a restart and a `rescanPlugins` with the plugin loaded, and `omarchy plugin remove sh.moshcode.herd` leaves nothing behind. A sustained run is watched for leaked processes: with the panel open for an hour, the process count at the end equals the count at the start.
- R14 [P0] Listing: submit through the marketplace's GitHub issue template at `omacom/omarchy-plugin-marketplace` (repository link, category, tags), after the automated validation passes on the submitted commit. The listing carries the name, author, description and `preview.png` from the manifest and the repo, so those are written for a stranger reading a card, not for us.
- R15 [P0] Launch is part of shipping, not after it: once the listing is live, the house announcement flow runs (socials, blog, ads) and the plugin's README links back to moshcode's install path.
- R16 [P1] The contract is versioned in both directions. `status --json` carries `schema`, and the plugin renders any `schema` it knows and says "unsupported snapshot" for anything newer rather than misreading fields. The manifest's README states the minimum moshcode version, and `omarchy doctor` compares it.
- R17 [P2] Panel actions, behind an explicit confirm step each: attach a session (spawn the terminal on `moshcode herd attach <name>`) and stop a swarm (`moshcode fleet stop <swarm>`). Deliberately deferred: every one of these is a write from an unsandboxed process, and the read-only version has to be boring in the wild first.

## UX Notes

Four states, one glyph. **Idle**: dimmed, the agent count, no money. **Busy**: normal foreground, count plus `$/h` once the floor is passed. **Blocked**: the theme's accent, blocked count first, and it stays that way until the question is answered. **Unavailable**: dimmed with a dot, and the reason in the panel rather than a tooltip nobody hovers.

The panel opens on click and on the shell's keyboard route, and closes on Escape. It is a dense list because the point is to scan it in two seconds and then either go to a terminal or forget about it. Nothing animates. The numbers in it are the same numbers `moshcode ps` and `moshcode cost` print, in the same order, with the same names, so nobody has to learn a second vocabulary for the same fleet.

Default section is `right`, with the clock and the system indicators, because this is a status, not content. It is allowed anywhere, and `allowMultiple` is false since a second copy would poll a second time for the same answer.

## Success Metrics

- Time from an agent entering `blocked` to a human noticing, measured by the gap between the ledger's block and the next input to that session. Target: minutes, from the current "until someone happens to look".
- `moshcode ps` and `moshcode cost` typed by hand on an Omarchy box drop, because the answer is already on screen.
- Zero shell crashes or restarts attributable to the plugin, measured over the first month of daily use. A bar that falls over once will be uninstalled and never reinstalled.
- The snapshot's own work stays small: the cost half, the roster and the fleet summary together under 300ms of the process's time, measured inside the process rather than by wall clock, since wall clock is dominated by a node start-up nothing here controls. (Measured at implementation: roster 215ms, fleets 1ms, burn 5ms on a cache hit.)
- Listed in the marketplace, with installs and stars as a secondary read on whether any of this generalises beyond one user.

## Risks & Open Questions

- **Nothing here can be tested on this box.** The dev machine is Ubuntu 26.04 and has no `omarchy`, `omarchy-shell`, `quickshell` or `qmllint` on PATH. The CLI half (R1, R2, R11) is testable locally; every QML requirement and all of R13 needs a real Omarchy install. Decide early whether that is a VM, a spare machine, or a borrowed one, because it gates the entire plugin half.
- **Unsandboxed, shared process.** The blast radius of a bug is the user's whole bar, not our widget. Mitigation is the shape of R7 and R9: one process, no shell, guarded parses, and no writes. It should still be reviewed as if it were a daemon, because it effectively is one.
- **A very young contract.** The marketplace lists zero community plugins and the manifest is at `schemaVersion: 1`. Fields, validation, and the CLI verbs may move under us. Re-run `omarchy plugin validate` against the current Omarchy release before every plugin release, and keep the QML small enough that a breaking change is an afternoon.
- **A poll is a process, and that is the real ceiling.** Measured at implementation: node start-up alone is ~200ms on this box, the moshcode CLI's own start-up takes it to ~550ms idle, and under the load of a working fleet a single `moshcode omarchy status --json` ranged from 0.66s to 4.2s. Lazy-loading the herd and cost module graphs keeps the cheap verbs cheap, but nothing in this repo can make a per-poll process free. If sub-second freshness is ever wanted, the honest answer is a long-lived writer (the `service` kind, or `herd serve`) and a plugin that only reads a file — which is a different PRD, and a daemon this one explicitly refused.

- **The cost half may not stay cheap.** `moshcode cost` reads transcripts, and 210ms on this machine is not a promise about a machine with a year of them. R2's cache and `partial` flag are the hedge; if they are not enough, the burn windows need an index rather than a scan, which is a separate piece of work in `src/cost.mjs`.
- **Repo split needs confirming.** The root-manifest requirement points at a separate `moshcoder/omarchy-moshcode` repository, which means a second release to keep in step. The alternative — a subdirectory here, mirrored out on release — keeps one repo but adds a publish step that can silently lag. Recommendation is the separate repo; it wants an explicit yes.
- **Process spawning from QML is assumed, not verified.** Quickshell's `Process`/`Io` types are referenced by Omarchy's shell reference rather than demonstrated in the plugin guide. Confirm on a real box that argv-style spawning without a shell is available to a third-party plugin before committing to R1's design; if it is not, the fallback is the CLI writing a snapshot file on a timer and the plugin only reading it, which is strictly worse but workable.
- **Does this also want a `service`?** A `service` plugin is a headless singleton, which is the right kind for raising a notification when an agent blocks while no bar widget is placed. It is out of scope here on purpose, but if the blocked alert is the reason the plugin exists, a widget-only delivery may be the wrong half of the feature.
- **Naming.** `moshcode plugin` already means Claude Code plugins and their marketplace, so this takes the `moshcode omarchy` namespace to avoid teaching one word two meanings. If a second desktop bar ever lands, that verb is wrong and becomes `moshcode bar`.
