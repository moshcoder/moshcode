// moshscript runtime — runs a .mosh file as JavaScript with the moshcode command
// vocabulary injected as globals. "secretly all js is legal."
//
// How it works:
//   - The script source is executed inside `with (scope) { … }` in an async
//     function. `scope` is a Proxy that resolves the command vocabulary
//     (mosh(), notify(), … — see registry.mjs) and the live `alive` flag.
//     Everything the proxy doesn't own (const/let locals, console, Math, real
//     JS) falls through to normal scoping, so full JavaScript works.
//   - `alive` is a getter. Each read counts one iteration against the --max
//     budget, so an unbounded `while (alive) { … }` loop terminates on its own;
//     `stop()` ends it early by flipping the flag. Straight-line scripts and
//     non-`alive` loops (a plain `for`) are not bounded by --max.
//
// This replaces the old custom-DSL interpreter as the execution path. The old
// grammar (`while (alive) { code(); … }`) is a strict subset of JS, so those
// scripts run unchanged.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Shared default iteration budget for both entrypoints (CLI `run` + TUI /run).
export const DEFAULT_MAX = 3;

/** Strip a leading `#!…` shebang line so `#!/usr/bin/env moshscript` files parse. */
export function stripShebang(src) {
  return src.startsWith("#!") ? src.replace(/^#![^\n]*\r?\n?/, "") : src;
}

// The loop governor: owns `alive` truthiness and the iteration budget.
function makeControl(max, out) {
  return {
    ticks: 0,
    stopped: false,
    warned: false,
    // Called on every read of `alive`. Returns whether the loop may continue.
    tick() {
      if (this.stopped) return false;
      if (this.ticks >= max) {
        if (!this.warned) {
          this.warned = true;
          out(`     ⏹  hit --max ${max} — stopping the pit (pass --max to go longer)`);
        }
        return false;
      }
      this.ticks++;
      return true;
    },
    stop() {
      this.stopped = true;
    },
  };
}

// The `with` target: a Proxy that owns exactly the vocabulary + a few specials,
// and lets every other identifier resolve through normal JS scoping.
//
// `pending` collects promises returned by async verbs the script did NOT await
// (e.g. a bare `notify("done")`), so runScript can drain them before returning —
// otherwise the process could exit before a fire-and-forget notification lands.
// Blocking verbs (the CLI verbs via spawnSync, sleep) return synchronously and
// need no draining, which is what keeps the simple no-`await` style correct.
function makeScope(registry, ctx, control, pending) {
  const bound = new Map();
  for (const cmd of registry.all()) {
    bound.set(cmd.name, (...args) => {
      const result = cmd.run(ctx, ...args);
      if (result && typeof result.then === "function") pending.push(result);
      return result;
    });
  }
  const owns = (key) =>
    key === "alive" || key === "argv" || key === "env" || bound.has(key);

  return new Proxy(Object.create(null), {
    has(_t, key) {
      // Symbols (incl. Symbol.unscopables) must fall through, or `with` breaks.
      if (typeof key === "symbol") return false;
      return owns(key);
    },
    get(_t, key) {
      if (key === "alive") return control.tick();
      if (key === "argv") return ctx.argv;
      if (key === "env") return ctx.env;
      return bound.get(key);
    },
    set(_t, key, value) {
      // Allow `alive = false` as an alias for stop(); protect the vocabulary.
      if (key === "alive") {
        control.stopped = !value;
        return true;
      }
      return false;
    },
  });
}

/**
 * Execute moshscript `source` as JavaScript.
 *
 * opts:
 *   commands  a registry (createRegistry) supplying the vocabulary  [required]
 *   max       iteration budget for `alive` loops (default DEFAULT_MAX)
 *   dryRun    narrate side effects instead of performing them
 *   argv      positional args exposed to the script as `argv`
 *   env       env exposed as `env` (defaults to process.env)
 *   out       sink for command output (defaults to console.log)
 *
 * Returns { iterations, stopped }.
 */
export async function runScript(source, opts = {}) {
  const registry = opts.commands;
  if (!registry || typeof registry.all !== "function") {
    throw new Error("moshscript: runScript needs a { commands } registry");
  }
  const out = opts.out || ((s) => console.log(s));
  const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX;
  const control = makeControl(max, out);

  const ctx = {
    out,
    dryRun: Boolean(opts.dryRun),
    argv: opts.argv || [],
    env: opts.env || process.env,
    control,
    get iter() {
      return control.ticks;
    },
    stop() {
      control.stop();
    },
  };

  const pending = [];
  const scope = makeScope(registry, ctx, control, pending);
  const body = `with (__scope__) {\n${stripShebang(source)}\n}`;
  const fn = new AsyncFunction("__scope__", body);
  await fn(scope);
  // Let any un-awaited async verbs (fire-and-forget notify) finish delivering.
  if (pending.length) await Promise.allSettled(pending);

  return { iterations: control.ticks, stopped: control.stopped };
}
