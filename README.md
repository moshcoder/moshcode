# moshcode 🤘

A metal scripting toolkit. Paste dead-simple, readable scripts and run them.

```
while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
```

## Run

```sh
moshcode run examples/alive.mosh        # run a script
moshcode run - < script.mosh            # or pipe/paste from stdin
moshcode run --max 5                    # bound the while loop (default 3)
echo 'say("hi"); notify();' | moshcode run -
moshcode commands                       # list built-in commands
moshcode help
```

No install/build step — it's plain ESM. `node bin/moshcode.mjs …` works too.

## moshscript

The whole language:

- `while (alive) { … }` — loops the body while the `alive` flag is set (bounded by `--max`).
- `name(args…);` — call a command. `//` comments are ignored.

Built-in commands: `code()` `mosh()` `notify()` `repeat()` `say("…")` `sleep(ms)` `stop()`.

### notify()

Pings **moshcoding.com web notifications**, and — if `MOSHCODE_WEBHOOK_URL` is set —
also POSTs to that webhook. Both are HMAC-signed (`X-Moshcode-Signature`) with
`MOSHCODE_WEBHOOK_SECRET`.

### Add your own commands

```js
import { defaultCommands } from "moshcode/src/commands.mjs";
const commands = { ...defaultCommands(), deploy: (ctx) => ctx.out("shipping…") };
```

## Env

| var | default | purpose |
|---|---|---|
| `MOSHCODE_API` | `https://moshcoding.com` | web-notifications endpoint host |
| `MOSHCODE_WEBHOOK_URL` | — | optional extra webhook for `notify()` |
| `MOSHCODE_WEBHOOK_SECRET` | — | signs notify() posts |
