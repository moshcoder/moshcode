---
openprd: "0.2"
id: "0013"
title: "Add persistent SSH workspaces for humans and agents"
status: "Draft"
authors:
  - "anthony@profullstack.com"
created: "2026-09-03"
updated: "2026-09-03"
repo: "https://github.com/moshcoder/moshcode"
discussion: ""
implementation: "src/ssh.mjs, src/cli-schema.mjs, src/commands.mjs, src/tui.mjs, bin/moshcode.mjs, test/ssh.test.mjs, test/ssh-sshd.test.mjs"
tags:
  - ssh
  - remote
  - runtime
  - agents
  - chovy
  - workspaces
supersedes: ""
superseded-by: ""
---

# Add persistent SSH workspaces for humans and agents

## Problem

MoshCode already has a strong persistent-local-runtime model:

- `herd` keeps local shells and agents alive in tmux or the PTY fallback.
- `herd prompt`, `read`, `wait`, and `--json` make those sessions controllable by another agent.
- `shell()` and the pit's shell execution path deliberately use the user's real shell.
- the project remains zero-dependency ESM and delegates terminal/process behavior to native tools instead of embedding a terminal implementation.

What it does **not** have is a first-class remote-shell/workspace abstraction.

Today a caller such as Chovy can invoke the system `ssh` command repeatedly, but if every file read, file edit, `git status`, test run, or inspection starts a brand-new SSH process with a brand-new transport, it repeatedly pays for:

- TCP setup;
- SSH negotiation;
- host-key negotiation;
- authentication;
- key-agent interaction;
- session setup;
- remote-shell startup.

That is unnecessary. SSH is explicitly capable of carrying many independent channels over one authenticated transport.

The immediate Chovy use case is concrete: an AI coding run may inspect and modify dozens or hundreds of files on one remote workspace. Chovy should not create a completely new authenticated SSH transport for every operation.

A naive `/ssh` command that merely does this:

```sh
ssh user@host
```

would not solve the problem. The user can already type that as a normal shell command.

The useful feature is instead a **persistent SSH workspace manager**:

```text
one authenticated OpenSSH master connection
              │
              ├── exec channel → git status
              ├── exec channel → cat package.json
              ├── exec channel → apply a multi-file patch
              ├── exec channel → pnpm test
              ├── scp/sftp-style file transfer
              └── optional remote tmux shell
```

Each operation remains independently observable and machine-readable while reusing the same authenticated connection.

This is especially useful for AI systems. Models generally work better with discrete tool calls returning bounded stdout/stderr and exit status than by pretending to be a human typing blindly into one long terminal stream. A persistent transport should therefore **not** imply that all AI activity must share one stateful shell.

MoshCode needs both:

1. multiplexed stateless command channels over one SSH connection; and
2. an optional persistent interactive remote shell for workflows that actually require shell state, a REPL, a TUI, a dev server, or a long-running process.

## Source Review / Why This Fits MoshCode

The current codebase already contains most of the concepts needed for this feature.

### Existing shell abstraction

`src/shell.mjs` centralizes how the pit runs shell commands, including interactive rc-file behavior and terminal/job-control details. The proposed SSH implementation should follow the same principle: one authoritative module should own SSH invocation construction and lifecycle behavior.

### Existing persistent runtime

`src/herd.mjs` already:

- detects tmux and PTY capabilities;
- creates named persistent sessions;
- captures output;
- sends literal input;
- attaches a terminal;
- keeps session metadata;
- exposes machine-readable controls.

The SSH feature should reuse the **design philosophy**, not tunnel every SSH command through herd.

### Existing machine interface

The herd intentionally has no separate hidden API: CLI verbs use `--json`, and scripts/agents consume the same concepts. `/ssh` should follow that rule.

### Existing zero-dependency posture

MoshCode is deliberately zero-dependency ESM. Do **not** add `ssh2`, `node-pty`, libssh bindings, or a custom SSH protocol implementation.

Use the installed OpenSSH client and its native connection-multiplexing support.

## Goals

- Allow many remote commands to reuse one authenticated SSH transport.
- Make remote execution dramatically cheaper than reconnecting for every command.
- Give humans a natural `/ssh` pit command and `moshcode ssh` CLI.
- Give AI systems a structured, machine-readable `ssh exec` interface.
- Preserve discrete stdout, stderr, exit status, timeout, and cancellation behavior for each operation.
- Support stdin so an agent can apply a multi-file patch in one remote operation.
- Support an optional truly persistent remote shell when shell state matters.
- Reuse the user's existing OpenSSH configuration, ssh-agent, known_hosts, ProxyJump, identities, and hardware-backed keys.
- Keep credentials and private keys out of MoshCode storage.
- Keep the project zero-dependency ESM.
- Fail soft when OpenSSH or an optional remote capability such as tmux is unavailable.
- Make the feature directly useful to Chovy without making Chovy depend on MoshCode internals.

## Non-Goals

- Implement the SSH protocol in JavaScript.
- Replace OpenSSH.
- Store SSH passwords.
- Store private keys.
- Disable host-key checking.
- Invent a second `~/.ssh/config`.
- Force every remote command through one interactive PTY.
- Require MoshCode to be installed on the remote host.
- Require tmux for normal `ssh exec`.
- Build a remote filesystem/FUSE mount.
- Build an IDE file browser.
- Replace rsync, scp, or sftp.
- Automatically deploy MoshCode to remote machines.
- Make SSH itself an A2A protocol.
- Treat a remote shell as an AI agent when it is not one.

## Users

### Chovy / agentic application backend

Needs to perform many file and shell operations against one remote app workspace during a coding run without opening a new authenticated SSH transport every time.

### MoshCode operator

Wants to type:

```text
/ssh dev
```

and land on a configured remote box, or:

```text
/ssh exec dev -- git status
```

without thinking about connection multiplexing.

### Coding agent

Needs deterministic tools such as:

```sh
moshcode ssh exec dev --json -- git diff --stat
```

rather than scraping an interactive terminal.

### Automation / moshscript

Needs to open a connection, execute several operations, branch on exit codes, and close or leave the connection available for later reuse.

## Product Principle

**Persistent connection, discrete operations.**

The transport stays alive. Commands do not have to share shell state.

This is the default:

```text
AI
 │
 ├─ exec("pwd") ───────────────┐
 ├─ exec("git status") ────────┤
 ├─ exec("git apply -", stdin) ┤
 └─ exec("pnpm test") ─────────┤
                               ▼
                    one OpenSSH master
                               │
                               ▼
                         remote server
```

Use a stateful remote shell only when the task truly needs one:

```text
AI / human
    │
    ▼
remote tmux shell
    │
    ├── cd persists
    ├── exports persist
    ├── dev server persists
    ├── REPL persists
    └── TUI persists
```

## Requirements

### Phase 1 — Named SSH targets

- **R1 [P0]** Add a core `moshcode ssh` command and `/ssh` pit command.

- **R2 [P0]** Support named targets:

  ```sh
  moshcode ssh add dev deploy@example.com
  moshcode ssh add dev deploy@example.com --port 2222
  moshcode ssh add dev deploy@example.com --cwd /srv/app
  moshcode ssh add dev my-ssh-config-host
  ```

- **R3 [P0]** Store only non-secret metadata under:

  ```text
  ~/.moshcode/ssh/targets.json
  ```

  Suggested shape:

  ```json
  {
    "dev": {
      "target": "deploy@example.com",
      "port": 22,
      "cwd": "/srv/app"
    }
  }
  ```

- **R4 [P0]** `targets.json` MUST NOT contain:
  - passwords;
  - private-key contents;
  - passphrases;
  - ssh-agent material;
  - temporary auth tokens.

- **R5 [P0]** Allow normal OpenSSH host aliases as targets so existing `~/.ssh/config` remains authoritative:

  ```sshconfig
  Host devbox
      HostName 203.0.113.10
      User deploy
      IdentityFile ~/.ssh/id_ed25519
      ProxyJump bastion
  ```

  then:

  ```sh
  moshcode ssh add dev devbox
  ```

- **R6 [P0]** Commands:

  ```sh
  moshcode ssh
  moshcode ssh list
  moshcode ssh add <name> <target>
  moshcode ssh remove <name>
  moshcode ssh show <name>
  ```

  Bare `moshcode ssh` lists configured targets and connection state.

- **R7 [P0]** Every non-interactive verb supports `--json`.

### Phase 2 — Persistent OpenSSH transport

- **R8 [P0]** Use native OpenSSH connection multiplexing.

  MoshCode MUST establish a control master rather than keeping a Node child process with a hand-rolled protocol.

  Conceptually:

  ```sh
  ssh \
    -o ControlMaster=yes \
    -o ControlPersist=10m \
    -o ControlPath=<moshcode-control-socket> \
    -N -f \
    devbox
  ```

- **R9 [P0]** Add:

  ```sh
  moshcode ssh open <name>
  moshcode ssh check <name>
  moshcode ssh close <name>
  ```

  Pit equivalents:

  ```text
  /ssh open dev
  /ssh check dev
  /ssh close dev
  ```

- **R10 [P0]** Opening an already-live master is idempotent and returns success with `alreadyOpen: true`.

- **R11 [P0]** Connection state MUST be checked using OpenSSH's control operations where supported, e.g. `ssh -O check`.

- **R12 [P0]** Closing MUST use OpenSSH's control operation, e.g. `ssh -O exit`, rather than killing arbitrary PIDs.

- **R13 [P0]** Default to a finite `ControlPersist` window after the last client disconnects. Initial default: 10 minutes.

  Configurable by:

  ```sh
  --persist 30m
  ```

  and:

  ```text
  MOSHCODE_SSH_PERSIST=30m
  ```

- **R14 [P0]** Use connection keepalives appropriate for unattended agents:

  ```text
  ServerAliveInterval=30
  ServerAliveCountMax=3
  ```

  unless the user has explicitly configured alternatives.

- **R15 [P0]** If the master dies or a control socket becomes stale, the next operation MUST:
  1. detect the failure;
  2. clean up only MoshCode-owned stale state;
  3. establish a new master;
  4. retry the requested operation once.

- **R16 [P0]** Control socket paths MUST avoid Unix-domain-socket path-length failures.

  Do not derive a long socket filename directly from `user@host:/workspace/path`.

  Use a stable short hash:

  ```text
  ~/.moshcode/ssh/control/7f31a8c2
  ```

  If platform socket limits make even that unsafe, use a private runtime directory such as:

  ```text
  /tmp/moshcode-ssh-<uid>/
  ```

- **R17 [P0]** Any runtime/control directory containing sockets MUST be mode `0700`.

### Phase 3 — Discrete command execution

- **R18 [P0]** Add:

  ```sh
  moshcode ssh exec <name> -- <command> [args...]
  ```

  Example:

  ```sh
  moshcode ssh exec dev -- git status --short
  ```

- **R19 [P0]** `ssh exec` MUST automatically reuse the named target's master connection.

- **R20 [P0]** `ssh exec` MUST default to **no PTY**.

  This keeps:
  - stdout deterministic;
  - stderr deterministic;
  - binary-safe stdin possible;
  - automation predictable.

- **R21 [P0]** Add `--tty` for commands that require a terminal:

  ```sh
  moshcode ssh exec dev --tty -- sudo systemctl status nginx
  ```

- **R22 [P0]** Return the command's actual remote exit status.

- **R23 [P0]** `--json` output shape:

  ```json
  {
    "ok": true,
    "target": "dev",
    "connected": true,
    "code": 0,
    "signal": null,
    "stdout": " M src/app.ts\n",
    "stderr": "",
    "durationMs": 84
  }
  ```

- **R24 [P0]** Failed remote commands are not transport failures.

  Example: remote `grep` exits `1`.

  JSON:

  ```json
  {
    "ok": false,
    "transportOk": true,
    "code": 1
  }
  ```

  This distinction matters to agents.

- **R25 [P0]** SSH/network/auth failures MUST be distinguished from remote command failures.

  Example:

  ```json
  {
    "ok": false,
    "transportOk": false,
    "code": 255,
    "error": "ssh authentication failed"
  }
  ```

- **R26 [P0]** Support timeout:

  ```sh
  moshcode ssh exec dev --timeout 2m -- pnpm test
  ```

- **R27 [P0]** Support per-operation cwd:

  ```sh
  moshcode ssh exec dev --cwd /srv/app -- git status
  ```

  If omitted, use the target's configured default cwd.

- **R28 [P1]** Support per-operation environment values:

  ```sh
  moshcode ssh exec dev --env NODE_ENV=test -- pnpm test
  ```

  These values apply to that operation only.

- **R29 [P0]** Do not emulate shell persistence for `exec`.

  This should **not** work by accident:

  ```sh
  moshcode ssh exec dev -- cd /tmp
  moshcode ssh exec dev -- pwd
  ```

  The second command should still use the configured/default cwd.

  Persistent shell state belongs to the shell-session feature.

### Phase 4 — stdin and agent-friendly file editing

- **R30 [P0]** `ssh exec` MUST be able to forward stdin.

  Example:

  ```sh
  printf '%s\n' "$PATCH" |
    moshcode ssh exec dev --stdin --cwd /srv/app -- git apply -
  ```

- **R31 [P0]** stdin MUST remain raw and must not be shell-escaped, JSON-encoded, line-split, or interpreted by MoshCode.

- **R32 [P0]** This is the recommended Chovy multi-file-edit path:

  ```text
  model produces unified diff
           │
           ▼
  one `ssh exec --stdin`
           │
           ▼
       `git apply -`
           │
           ▼
  many files changed atomically-ish in one remote command
  ```

  This is preferable to one SSH operation per changed file when the model already has a patch.

- **R33 [P1]** Add convenience transfer verbs backed by OpenSSH-native tools:

  ```sh
  moshcode ssh put dev ./local-file /srv/app/file
  moshcode ssh get dev /srv/app/file ./local-file
  ```

  Implementation may use `scp` with the same ControlPath.

- **R34 [P1]** `put` SHOULD support atomic replacement for individual files:
  1. copy to a temporary sibling path;
  2. rename on the remote filesystem.

- **R35 [P1]** No custom SFTP implementation.

### Phase 5 — Interactive connection

- **R36 [P0]** Bare named target attaches a normal interactive SSH session:

  ```sh
  moshcode ssh dev
  ```

  pit:

  ```text
  /ssh dev
  ```

- **R37 [P0]** Interactive attach MUST reuse the same ControlMaster when available.

- **R38 [P0]** Interactive mode hands the terminal directly to OpenSSH. MoshCode does not parse or redraw the remote terminal.

- **R39 [P0]** Ctrl-C, terminal resize, colors, mouse input, TUIs, vim, top, btop, and nested agent CLIs should behave as they do under ordinary OpenSSH.

- **R40 [P0]** Exiting the interactive shell does **not** necessarily close the master connection. `ControlPersist` governs transport lifetime.

### Phase 6 — Persistent stateful remote shell

A multiplexed SSH connection avoids repeated authentication, but separate `exec` channels intentionally do not preserve shell state.

Some workflows need actual state:

```sh
cd /srv/app
export DEBUG=1
pnpm dev
```

or an interactive CLI that stays alive.

- **R41 [P1]** Add:

  ```sh
  moshcode ssh shell <target> --name <session>
  ```

  Example:

  ```sh
  moshcode ssh shell dev --name app
  ```

- **R42 [P1]** When remote tmux exists, create-or-attach a namespaced remote tmux session:

  ```text
  moshcode-ssh-<local-target>-<session>
  ```

- **R43 [P1]** The remote shell persists independently of the local terminal and independently of the local SSH transport. If the laptop sleeps, the remote tmux shell remains.

- **R44 [P1]** Add non-attaching machine controls:

  ```sh
  moshcode ssh shell send dev/app "pnpm test"
  moshcode ssh shell read dev/app --lines 80
  moshcode ssh shell kill dev/app
  ```

- **R45 [P1]** `send` MUST write literal text followed by Enter, matching herd's existing literal-input safety model.

- **R46 [P1]** `read` uses remote `tmux capture-pane`, returning terminal text rather than requiring the caller to attach.

- **R47 [P1]** The remote shell feature MUST gracefully report when tmux is unavailable on the remote machine.

  Normal `ssh exec` remains fully functional.

- **R48 [P1]** Do not silently install tmux remotely.

### Phase 7 — Moshscript / agent API

- **R49 [P0]** Expose value-returning moshscript helpers instead of forcing scripts to parse human text.

  Proposed:

  ```js
  sshOpen("dev");
  const r = sshExec("dev", ["git", "status", "--short"], {
    cwd: "/srv/app"
  });

  if (!r.ok) {
    say(r.stderr);
  }

  sshClose("dev");
  ```

- **R50 [P0]** `sshExec()` returns the same conceptual object as CLI `--json`:

  ```js
  {
    ok,
    transportOk,
    code,
    signal,
    stdout,
    stderr,
    durationMs
  }
  ```

- **R51 [P1]** Support stdin in moshscript:

  ```js
  sshExec("dev", ["git", "apply", "-"], {
    cwd: "/srv/app",
    stdin: patch
  });
  ```

- **R52 [P1]** Add shell-session helpers only if Phase 6 is implemented:

  ```js
  sshShellSend("dev/app", "pnpm test");
  const screen = sshShellRead("dev/app", { lines: 50 });
  ```

  (Starting a shell hands the terminal to ssh, so it is a CLI verb rather
  than a script helper; a script drives an existing shell with `send`,
  `read` and `kill`.)

### Phase 8 — Chovy integration contract

The feature should be usable by Chovy strictly through the public CLI. Chovy must not import MoshCode private modules.

Recommended lifecycle:

```sh
# once when a workspace is provisioned
moshcode ssh add chovy-app app@server --cwd /srv/chovy/workspace

# once at the beginning of an active coding run
moshcode ssh open chovy-app --json
```

Then every AI tool operation:

```sh
moshcode ssh exec chovy-app --json -- git status --short
```

Read a file:

```sh
moshcode ssh exec chovy-app --json -- sed -n '1,240p' src/app.ts
```

Apply a model-generated multi-file patch:

```sh
moshcode ssh exec chovy-app \
  --json \
  --stdin \
  --cwd /srv/chovy/workspace \
  -- git apply -
```

Run tests:

```sh
moshcode ssh exec chovy-app \
  --json \
  --timeout 10m \
  --cwd /srv/chovy/workspace \
  -- pnpm test
```

Optional interactive debug:

```sh
moshcode ssh chovy-app
```

Optional persistent remote dev shell:

```sh
moshcode ssh shell chovy-app --name dev
```

At run completion:

```sh
moshcode ssh close chovy-app
```

or simply let `ControlPersist` expire.

- **R53 [P0]** Chovy SHOULD keep using discrete model tool calls.

- **R54 [P0]** Chovy SHOULD NOT force all model actions through a single interactive shell merely to avoid reconnect cost.

- **R55 [P0]** Chovy SHOULD batch model file changes into unified diffs where practical and apply one patch through stdin.

- **R56 [P0]** Chovy MAY run independent commands concurrently over the same master connection. SSH multiplexing should allow several logical channels over one authenticated transport.

- **R57 [P0]** A single Chovy coding run should normally perform one SSH authentication/transport setup, not one per file.

## UX Notes

### Human pit flow

```text
mosh ▸ /ssh add dev deploy@dev.example.com --cwd ~/src/app
✓ dev → deploy@dev.example.com

mosh ▸ /ssh open dev
✓ dev connected

mosh ▸ /ssh exec dev -- git status --short
 M src/app.ts

mosh ▸ /ssh dev
deploy@dev:~/src/app$
```

Leaving the remote shell returns to the pit while the master connection remains reusable.

### Connection list

```text
mosh ▸ /ssh

name       target                    state       cwd
dev        deploy@dev.example.com    connected   ~/src/app
prod       deploy@prod.example.com   closed      /srv/app
```

### JSON list

```json
{
  "targets": [
    {
      "name": "dev",
      "target": "deploy@dev.example.com",
      "connected": true,
      "cwd": "~/src/app"
    }
  ]
}
```

### Shell session

```text
mosh ▸ /ssh shell dev --name app
dev/app ▸ ~/src/app

deploy@dev:~/src/app$ pnpm dev
```

Detach behavior should be documented clearly. If remote tmux is used, detaching must leave the remote process alive.

## CLI Surface

```text
moshcode ssh
moshcode ssh list
moshcode ssh add <name> <target> [--port N] [--cwd PATH]
moshcode ssh remove <name>
moshcode ssh show <name>

moshcode ssh open <name> [--persist 10m]
moshcode ssh check <name>
moshcode ssh close <name>

moshcode ssh <name>
moshcode ssh exec <name> [--cwd PATH] [--env K=V] [--stdin] [--tty] [--timeout DURATION] -- <command...>

moshcode ssh put <name> <local> <remote>
moshcode ssh get <name> <remote> <local>

moshcode ssh shell <name> --name <session>
moshcode ssh shell send <name>/<session> <text>
moshcode ssh shell read <name>/<session> [--lines N]
moshcode ssh shell kill <name>/<session>

moshcode ssh bench <name> [--n 20]
```

Every appropriate verb:

```text
--json
```

Pit facade:

```text
/ssh ...
```

## Architecture

### New module: `src/ssh.mjs`

Own:

- target registry;
- control socket naming;
- OpenSSH capability detection;
- master open/check/close;
- invocation construction;
- exec;
- stdin forwarding;
- output capture;
- timeout;
- interactive attach;
- scp convenience;
- optional remote tmux shell helpers.

No SSH command construction should be duplicated in `cli.mjs`, `commands.mjs`, or Chovy.

### `src/cli-schema.mjs`

Add the canonical help schema for `ssh` and its verbs.

The README command table is generated from the command schema, so `/ssh` must enter through the same canonical command/help path as existing commands.

### `bin/moshcode.mjs`

Dispatch `moshcode ssh ...` into `src/ssh.mjs`.

### `src/commands.mjs`

Expose:

```js
cliVerb("ssh", "connect to and operate persistent remote SSH workspaces")
```

plus value-returning moshscript helpers where required.

### `src/runtime.mjs`

The runtime injects every registered command as a global, so the helpers in
`src/commands.mjs` are the injection; no runtime change is needed.

### Relationship to `src/herd.mjs`

Phase 1 does not change herd.

This is intentional:

- herd owns local persistent processes and agent state;
- ssh owns remote transport and remote command execution.

Future integration may allow a remote SSH shell or an SSH-launched remote agent to appear in `moshcode ps`, but `/ssh` should first work cleanly as an independent transport primitive.

## OpenSSH Invocation Strategy

Implementation builds argv arrays, never a shell string.

### Master

```sh
ssh \
  -o ControlMaster=yes \
  -o ControlPersist=600 \
  -o ControlPath=/private/path/abc123 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=20 \
  -N -f \
  devbox
```

Note the absence of `-M`. Found in testing: `-M` together with
`-o ControlMaster=yes` is read by ssh as a *second* request for master mode,
which means **ask** mode — every later client then needs an askpass
confirmation, and headless the answer is "Master refused session request:
Permission denied". One spelling or the other, never both.

### Check

```sh
ssh \
  -o ControlPath=/private/path/abc123 \
  -O check \
  devbox
```

### Close

```sh
ssh \
  -o ControlPath=/private/path/abc123 \
  -O exit \
  devbox
```

### Exec

```sh
ssh \
  -o ControlPath=/private/path/abc123 \
  -o ControlMaster=auto \
  -o ControlPersist=600 \
  -T \
  devbox \
  -- <remote-command>
```

`ControlMaster=auto` on the client is the native stale-socket recovery: a
socket nobody is listening on is unlinked and the client becomes the new
master, so a master that died between two commands costs one reconnect.

The remote command is built from argv with POSIX single-quoting:

```text
cd -- '/srv/app' && NODE_ENV='test' exec 'pnpm' 'test'
```

A `--sh` flag passes a single argument as a shell snippet on purpose; nothing
is ever guessed to be one.

## Security

- **R58 [P0]** Never pass `StrictHostKeyChecking=no`.
- **R59 [P0]** Respect normal OpenSSH `known_hosts` behavior.
- **R60 [P0]** Never persist passwords.
- **R61 [P0]** Never copy private keys into `~/.moshcode`.
- **R62 [P0]** Prefer ssh-agent, OpenSSH config, hardware-backed keys, and standard identity files.
- **R63 [P0]** Redact obvious secret-bearing CLI arguments from debug logs where MoshCode controls logging.
- **R64 [P0]** Do not print full stdin payloads in debug output.
- **R65 [P0]** The socket/control directory must be private to the current OS user.
- **R66 [P0]** Refuse target names containing path separators or traversal components.
- **R67 [P0]** Registry file writes must be atomic and owner-only.
- **R68 [P0]** Remote commands must be built from argv with explicit quoting rules.
- **R69 [P0]** `--env` values must not be echoed in ordinary human output.
- **R70 [P0]** The feature must not weaken the user's existing SSH policy.

## Failure Modes

### OpenSSH missing

```text
✗ ssh not found — install an OpenSSH client
```

No package is auto-installed.

### Authentication requires interaction

Interactive `/ssh dev` may naturally allow OpenSSH to ask.

Headless `ssh exec --json` should fail clearly rather than hang indefinitely.
`BatchMode=yes` is passed whenever stdin is not a terminal or `--batch` is
given; with a terminal attached, OpenSSH may prompt as it normally would.

### Unknown host key

Use native OpenSSH behavior. Do not auto-accept.

### Stale master socket

Detect → clean MoshCode-owned stale socket → reconnect → retry once.

### Remote command exits nonzero

Return command exit status without calling it an SSH failure.

### Remote tmux missing

Only `ssh shell` persistent mode is unavailable. `ssh exec` still works.

### Local process dies

A detached ControlMaster may survive according to OpenSSH behavior and ControlPersist. Remote tmux shells survive regardless of the local master.

## Performance Expectations

The feature exists to remove repeated SSH handshakes from high-churn agent workloads.

### Required measurement

`moshcode ssh bench <name> [--n N]` compares:

```text
N × fresh ssh "true"
```

against:

```text
1 × master connection
N × multiplexed ssh "true"
```

and reports total wall time, median and p95 latency, failures, and the number
of authentications each side performed.

Measured on a loopback sshd on the development box (20 runs each): fresh
~96ms median, multiplexed ~12ms median. Real hosts will differ; the number to
quote is the one `bench` prints for your own host.

## Success Metrics

- A Chovy run that performs 100 remote operations normally authenticates once rather than 100 times.
- Median subsequent `ssh exec` startup latency is materially lower than a fresh SSH connection on the same host.
- File edits can be applied as one multi-file patch over stdin.
- `ssh exec --json` exposes stdout, stderr, exit status, transport status, and duration without terminal scraping.
- Interactive `/ssh <name>` behaves like normal OpenSSH.
- Existing `~/.ssh/config` features continue to work.
- No SSH private key or password is stored by MoshCode.
- No runtime npm dependency is added.
- MoshCode remains usable when tmux is absent.
- Tests cover stale sockets, failed authentication, remote exit codes, stdin, quoting, cwd, and JSON output.

## Test Plan

### Unit (`test/ssh.test.mjs`)

- target-name validation;
- registry read/write;
- control-path hashing;
- OpenSSH argv construction;
- port handling;
- cwd encoding;
- environment encoding;
- remote argv quoting;
- JSON shapes;
- exit-code mapping;
- transport-vs-command failure classification;
- timeout parsing;
- stale-socket recovery decision logic.

### Integration (`test/ssh-sshd.test.mjs`)

An ephemeral, non-root `sshd` on a loopback port with generated keys and a
private `ssh_config` (pointed at through `MOSHCODE_SSH_CONFIG`). Skipped, not
failed, where `sshd` or `ssh-keygen` is unavailable.

1. add target;
2. open master;
3. check master;
4. exec `printf`;
5. exec failing command;
6. stdin round trip;
7. cwd;
8. parallel exec channels;
9. close master;
10. automatic reopen;
11. host-key failure;
12. authentication failure;
13. `scp` reuse via `put`/`get`.

### Remote tmux

When tmux is present in the test image:

1. send `cd` and `pwd`, verify state persists;
2. read the screen;
3. kill.

## Documentation

README section `## SSH workspaces`, leading with:

> `/ssh` keeps the SSH connection alive; `ssh exec` still gives each tool call a clean command channel.

with a Chovy/agent example showing one connection and a multi-file `git apply -`, and `moshcode help ssh`.

## Rollout

### Milestone 1

- target registry;
- `/ssh`;
- open/check/close;
- exec;
- JSON;
- stdin;
- cwd;
- tests.

This alone solves the Chovy reconnect problem.

### Milestone 2

- put/get;
- timeout polish;
- parallel execution tests;
- moshscript value helpers.

### Milestone 3

- persistent remote tmux shell;
- send/read/kill;
- optional herd bridge exploration.

## Future: Herd Bridge

Do not block this PRD on herd integration.

A later PRD may define:

```sh
moshcode herd remote add devbox --kind ssh --target dev
```

or allow:

```sh
moshcode ssh agent dev --engine claude --name api
```

to launch a MoshCode herd/agent on a remote machine.

The clean layering should be:

```text
herd / agent orchestration
          │
          ▼
     ssh workspace
          │
          ▼
       OpenSSH
```

not:

```text
SSH implementation hidden inside herd
```

## Risks & Open Questions

- OpenSSH multiplexing behavior differs slightly across platforms. POSIX/OpenSSH-first is acceptable, but capability checks must be explicit.
- ControlPath socket limits can be surprisingly small; hashed short paths are mandatory.
- Remote argv quoting is security-sensitive and deserves dedicated tests.
- `BatchMode=yes` is on whenever stdin is not a terminal, and `--batch` forces it; a person at a terminal can still be prompted.
- `ControlPersist=10m` is a reasonable default but Chovy may want a master open for the entire coding-run lifetime. Explicit `open` + `close` already handles that.
- `scp` behavior and flags have changed across OpenSSH versions; `put/get` are P1, not required for the core reconnect fix.
- Long-running noninteractive commands are still individual channels. If a command must outlive its caller, use remote tmux/systemd/herd rather than pretending `ssh exec` is a job supervisor.
- A future remote-herd abstraction should decide whether MoshCode is installed remotely or whether local MoshCode drives raw remote tmux. That decision is intentionally outside this PRD.

## Decision

Build `/ssh`, but build it as a **persistent SSH workspace primitive**, not as a convenience alias for `ssh`.

For Chovy, the key win is not "one forever-interactive shell." The key win is:

> **one authenticated SSH transport, many clean AI tool calls, plus an optional persistent remote shell when state is actually needed.**
