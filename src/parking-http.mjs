import http from "node:http";
import { DEFAULT_REGISTRY_BASE, pitNameUrl } from "./pit-url.mjs";

/**
 * The other half of parking: something that actually answers.
 *
 * DNS can only hand back an IP, so a parked name has always resolved *somewhere*
 * — but the address it pointed at was a platform that routes by Host header and
 * returns "Application not found" for a name it has never heard of. `curl
 * scrambled.eggs` resolved and then died one layer up.
 *
 * The bridge is already running on this machine for the name to resolve at all,
 * so it can serve the answer too: parked names point at loopback, and this
 * redirects whatever Host arrives to that name's page in the Pit. No public
 * host, and no certificate for an ending that no CA will ever sign.
 */

/** Port 80, because `curl <name>` has no way to say otherwise. */
export const DEFAULT_PARKING_HTTP_PORT = 80;

export function parkingRedirect(hostHeader, registryBase = DEFAULT_REGISTRY_BASE) {
  const name = String(hostHeader || "").split(":")[0].trim().toLowerCase();
  // One label and one ending is the only shape the registry holds; anything
  // else (an IP, a bare word, a subdomain) belongs at the Pit's front door.
  const isName = /^[a-z0-9-]+\.[a-z0-9-]+$/.test(name);
  return isName ? pitNameUrl(name, registryBase) : `${String(registryBase).replace(/\/+$/, "")}/pit`;
}

/**
 * Start the parking responder. Resolves { port, address, close() }, or rejects
 * when the port cannot be bound — port 80 needs privileges, and the caller
 * decides whether that is fatal.
 */
export function createParkingServer(options = {}) {
  const {
    port = DEFAULT_PARKING_HTTP_PORT,
    host = "127.0.0.1",
    registryBase = DEFAULT_REGISTRY_BASE,
    onRequest = () => {},
  } = options;

  const server = http.createServer((req, res) => {
    const target = parkingRedirect(req.headers.host, registryBase);
    onRequest({ host: req.headers.host || null, target });
    // 302, not 301: the owner can point this name at a real target at any
    // moment, and a cached permanent redirect would outlive that.
    res.writeHead(302, { location: target, "content-type": "text/plain; charset=utf-8" });
    // A body as well as the header, so `curl` without -L still says something
    // useful instead of printing nothing at all.
    res.end(`parked → ${target}\n`);
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => { server.close(); reject(err); };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve({
        port: server.address().port,
        address: host,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
