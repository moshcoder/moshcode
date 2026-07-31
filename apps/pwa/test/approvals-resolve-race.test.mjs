import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-approval-resolve-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");

  const execute = db.execute.bind(db);
  let selected = 0;
  let releaseReads;
  const readsReady = new Promise((resolve) => { releaseReads = resolve; });
  let firstRead;
  const firstReadReady = new Promise((resolve) => { firstRead = resolve; });

  db.execute = async (statement) => {
    const sql = typeof statement === "string" ? statement : statement?.sql || "";
    const args = typeof statement === "string" ? [] : statement?.args || [];
    if (/SELECT \* FROM approvals WHERE id = \?/.test(sql)) {
      const rows = await execute(statement);
      selected++;
      if (selected === 1) {
        firstRead();
        await readsReady;
      } else if (selected === 2) {
        releaseReads();
      }
      return rows;
    }
    if (/UPDATE approvals SET status/.test(sql) && args[0] === "killed") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return execute(statement);
  };

  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { approvalsRouter } = await import("../src/routes/approvals.mjs");

  const app = deps.express();
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(approvalsRouter);

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const port = server.address().port;

  await run(`INSERT INTO users (id,email,display_name,created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(
    `INSERT INTO approvals
      (id,user_id,message,kind,status,cap_token,cost,created_at)
     VALUES ('approval-race','u1','ship?','ask','pending','race-cap',0,1)`,
  );

  const send = (pathname, response) => new Promise((resolve, reject) => {
    const body = new URLSearchParams({ _csrf: "race-csrf", response }).toString();
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `${pathname}?t=race-cap`,
      method: "POST",
      agent: false,
      headers: {
        cookie: "mc_csrf=race-csrf",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });

  return { server, db, get, send, firstReadReady };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => {
    server.close();
    db.close?.();
  }).finally(() => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {}
  });
});

test("the first concurrent approval resolution wins", { skip: !deps && "pwa deps not installed" }, async () => {
  const { get, send, firstReadReady } = await app();

  const submitted = send("/approve/approval-race", "ship it");
  await firstReadReady;
  const killed = send("/approve/approval-race/kill", "");
  assert.deepEqual(await Promise.all([submitted, killed]), [302, 302]);

  const row = await get(`SELECT status, response FROM approvals WHERE id = 'approval-race'`);
  assert.deepEqual(
    { status: row.status, response: row.response },
    { status: "submitted", response: "ship it" },
  );
});
