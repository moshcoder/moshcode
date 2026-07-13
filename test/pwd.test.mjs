import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { tilde } from "../src/pwd.mjs";

test("tilde shortens the home directory itself", () => {
  const home = path.join("C:", "Users", "mosh");

  assert.equal(tilde(home, home), "~");
});

test("tilde shortens paths inside home", () => {
  const home = path.join("C:", "Users", "mosh");
  const project = path.join(home, "repo");

  assert.equal(tilde(project, home), `~${path.sep}repo`);
});

test("tilde does not shorten sibling paths with the same prefix", () => {
  const home = path.join("C:", "Users", "mosh");
  const sibling = path.join("C:", "Users", "mosh-other", "repo");

  assert.equal(tilde(sibling, home), sibling);
});
