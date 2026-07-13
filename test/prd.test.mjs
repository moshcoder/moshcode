import assert from "node:assert/strict";
import test from "node:test";

import { renderPrd } from "../src/prd.mjs";

test("renderPrd quotes titles so YAML metacharacters stay valid", () => {
  const body = renderPrd({
    id: "0001",
    title: 'Ship CLI: handle "quoted" flags',
    idea: 'Ship CLI: handle "quoted" flags',
    author: "dev@example.com",
  });

  assert.match(body, /^title: "Ship CLI: handle \\"quoted\\" flags"$/m);
});
