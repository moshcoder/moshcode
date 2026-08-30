// Saying where to forward, because discovery cannot always be asked.
//
// `discoverUpstreams` reads the machine's resolv.conf and drops loopback. That
// is right until the machine's resolver IS this bridge — then the only
// nameserver on file is the bridge itself, discovery correctly refuses to
// return it, and the daemon comes up with nowhere to forward. Every clearnet
// name NXDOMAINs, including the registry it needs in order to know which
// endings are Moshpit, so it answers for nothing either. The box loses DNS
// entirely and cannot look up the reason, because the lookup goes through the
// bridge.
//
// `dns enable` never hit this: it runs before the routing exists. A supervised
// bridge starting at boot hits it every single time, because the drop-in is a
// file and is already in place. Observed on a Kubuntu desktop as a journal full
// of `pit.moshcode.sh → NXDOMAIN` from the bridge that was supposed to answer
// it.
import test from "node:test";
import assert from "node:assert/strict";

import { upstreamsFromArgs } from "../src/dns.mjs";
import { serviceUnit } from "../src/dns-service.mjs";

const unit = (opts = {}) => serviceUnit({ entry: "/opt/m/bin/moshcode.mjs", port: 5354, execPath: "/opt/node/bin/node", ...opts });

test("one upstream, several, and the flag repeated all mean the same thing", () => {
  assert.deepEqual(upstreamsFromArgs(["--upstream", "1.1.1.1"]).servers, ["1.1.1.1"]);
  assert.deepEqual(upstreamsFromArgs(["--upstream", "1.1.1.1,8.8.8.8"]).servers, ["1.1.1.1", "8.8.8.8"]);
  assert.deepEqual(upstreamsFromArgs(["--upstream", "1.1.1.1", "--upstream", "8.8.8.8"]).servers, ["1.1.1.1", "8.8.8.8"]);
});

test("the resolv.conf spelling of a port is kept rather than a third one invented", () => {
  assert.deepEqual(upstreamsFromArgs(["--upstream", "9.9.9.9#5353"]).servers, ["9.9.9.9#5353"]);
});

test("IPv6 upstreams are addresses too", () => {
  assert.deepEqual(upstreamsFromArgs(["--upstream", "2606:4700:4700::1111"]).servers, ["2606:4700:4700::1111"]);
});

test("something that is not an address is reported, never forwarded to", () => {
  // Silently dropping it leaves a bridge that looks configured and answers
  // NXDOMAIN for the whole internet — the exact failure this flag exists for.
  const { servers, invalid } = upstreamsFromArgs(["--upstream", "one.one.one.one"]);
  assert.deepEqual(servers, []);
  assert.deepEqual(invalid, ["one.one.one.one"]);
});

test("a flag with no value is a typo, not a request for no upstreams", () => {
  assert.deepEqual(upstreamsFromArgs(["--upstream"]).invalid, ["(missing value)"]);
  assert.deepEqual(upstreamsFromArgs(["--upstream", "--port"]).invalid, ["(missing value)"]);
});

test("the same server twice is one server", () => {
  assert.deepEqual(upstreamsFromArgs(["--upstream", "1.1.1.1,1.1.1.1"]).servers, ["1.1.1.1"]);
});

test("no flag is no opinion — discovery still gets its turn", () => {
  assert.deepEqual(upstreamsFromArgs([]), { servers: [], invalid: [] });
  assert.deepEqual(upstreamsFromArgs(["--port", "5354"]), { servers: [], invalid: [] });
});

test("the generated unit carries the upstreams it was given", () => {
  // Recorded while a working resolver is still around to be asked. At boot,
  // when the unit actually runs, it will not be.
  assert.match(unit({ upstreams: ["1.1.1.1", "1.0.0.1"] }), /ExecStart=.* --upstream 1\.1\.1\.1,1\.0\.0\.1$/m);
});

test("a unit with nothing to record does not write an empty flag", () => {
  const text = unit({ upstreams: [] });
  assert.doesNotMatch(text, /--upstream/, "`--upstream` with no value is the typo case, not a default");
});
