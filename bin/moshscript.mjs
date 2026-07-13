#!/usr/bin/env node
// moshscript — thin alias for `moshcode run`, so `.mosh` files can use:
//
//   #!/usr/bin/env moshscript
//
// as a shebang and run themselves like shell scripts:
//
//   chmod +x deploy.mosh && ./deploy.mosh --dry-run staging
//
// All arguments are forwarded unchanged to `moshcode run`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("moshcode.mjs", import.meta.url));
const args = process.argv.slice(2); // everything after `moshscript`

const child = spawn(process.execPath, [BIN, "run", ...args], { stdio: "inherit" });
child.on("error", (e) => { console.error(`moshscript: ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); }
    catch { process.exitCode = 1; }
    return;
  }
  process.exitCode = code ?? 0;
});
