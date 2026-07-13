// The moshscript command registry — the single source of truth for the verbs a
// .mosh script can call.
//
// A command is a plain object: { name, summary, run(ctx, ...args) }.
//   - name:    the identifier the script calls, e.g. "mosh" → mosh()
//   - summary: one-liner for `moshcode commands` / help
//   - run:     the implementation; receives the runtime ctx plus the JS call
//              arguments spread out (so `notify("hi", "there")` → args = ["hi","there"]).
//
// The runtime (src/runtime.mjs) injects every registered command as a global of
// the same name, so scripts call them bare: `mosh()`, `notify("…")`. New verbs —
// engine launches, tool passthrough, fan-out — are added by registering more
// commands here (or via registry.register(...) from a host), never by touching
// the interpreter.

export function createRegistry(commands = []) {
  const byName = new Map();

  const register = (cmd) => {
    if (!cmd || typeof cmd.name !== "string" || typeof cmd.run !== "function") {
      throw new Error("moshscript: a command needs { name, run() }");
    }
    byName.set(cmd.name, { summary: "", ...cmd });
    return api;
  };

  const api = {
    register,
    has: (name) => byName.has(name),
    get: (name) => byName.get(name),
    all: () => [...byName.values()],
    names: () => [...byName.keys()],
  };

  commands.forEach(register);
  return api;
}
