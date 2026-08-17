// Publishing a lot at once, without holding it all in memory.
//
// The JSON batch endpoint buffers the whole request before the handler runs, so
// the most it can accept is the most we are willing to hold per request — and
// that ceiling is set by what a hostile caller could do, not by what a real one
// needs. Raising it to fit a real bulk import means agreeing to buffer that
// much for anyone who asks.
//
// Streaming removes the trade. NDJSON is one item per line, so the parser holds
// one line, the handler writes it, and the memory cost of a 500-item upload is
// the same as a 1-item one. The cap can then be about the daemon's total work
// rather than about a single allocation.
//
// The caps below exist because a streaming endpoint is a better DoS target than
// a buffered one, not a worse one: it accepts an open socket for as long as the
// client keeps trickling bytes. Every one of them bounds a different attack —
// total bytes, a single unbounded line, item count, idle time, and how many of
// these can run at once.

import { MAX_BODY, MAX_ITEMS_PER_NAME, MAX_TITLE } from "./moshpit-content.mjs";

/** The wire format: one JSON object per line. */
export const STREAM_CONTENT_TYPES = ["application/x-ndjson", "application/ndjson", "application/jsonl"];

/**
 * The most items one stream may carry.
 *
 * Equal to a name's whole capacity on purpose: one upload can fill a site and
 * cannot do more than fill it, so there is no batch size that accomplishes
 * something a single stream could not.
 */
export const MAX_STREAM_ITEMS = MAX_ITEMS_PER_NAME;

/**
 * The most one line may weigh.
 *
 * An item's fields are already bounded (MAX_BODY + MAX_TITLE and a gallery of
 * URLs), and JSON escaping can widen a character to six bytes. This is that,
 * rounded up — enough that no legitimate item is refused, small enough that a
 * single line can never be an unbounded allocation.
 */
export const MAX_LINE_BYTES = (MAX_BODY + MAX_TITLE) * 6 + 64 * 1024;

/** The most a whole stream may weigh, however it is split into lines. */
export const MAX_STREAM_BYTES = MAX_STREAM_ITEMS * MAX_LINE_BYTES;

/**
 * How long the stream may go without producing bytes.
 *
 * This is the slowloris guard. Without it a client can hold a connection and a
 * database handle open indefinitely by sending one byte a minute, which costs
 * them nothing and costs us a slot. Generous enough for a slow uplink mid-item.
 */
export const STREAM_IDLE_MS = 20_000;

/**
 * How many of these may run at once, process-wide.
 *
 * The real limit on concurrent bulk imports is the database behind them, not
 * the sockets. Past this the answer is 503 with a Retry-After rather than
 * queueing, because a queue is just a slower way to run out of memory.
 */
export const MAX_CONCURRENT_STREAMS = 4;

/** A cap was hit. Carries the status the route should report. */
export class StreamLimitError extends Error {
  constructor(code, message, status = 413) {
    super(message);
    this.name = "StreamLimitError";
    this.code = code;
    this.status = status;
  }
}

let active = 0;

/**
 * Take one of the concurrent-stream slots, or null when they are all taken.
 *
 * Returns the release function rather than a boolean so a caller cannot
 * acquire and forget which slot to give back — the only thing to hold onto is
 * the thing that frees it.
 */
export function acquireStreamSlot() {
  if (active >= MAX_CONCURRENT_STREAMS) return null;
  active += 1;
  let released = false;
  return () => {
    // Idempotent: the route releases in a finally block that can run after an
    // error path already released, and double-decrementing would hand out slots
    // that do not exist.
    if (released) return;
    released = true;
    active -= 1;
  };
}

/** Live count, for tests and for the 503's message. */
export function activeStreams() {
  return active;
}

/** Test seam — drops any leaked slots between cases. */
export function resetStreamSlots() {
  active = 0;
}

export function isStreamContentType(header) {
  const type = String(header || "").split(";")[0].trim().toLowerCase();
  return STREAM_CONTENT_TYPES.includes(type);
}

/**
 * Parse an NDJSON request body into items, one at a time.
 *
 * Yields `{ index, item }` as each line completes, so the caller can write it
 * and report progress before the next line has even arrived. Blank lines are
 * skipped — a trailing newline is the normal way to end a file, and treating it
 * as an empty item would fail every upload written by a well-behaved tool.
 *
 * A malformed line is yielded as `{ index, error }` rather than thrown. One bad
 * line in a bulk import should cost that line, not the several hundred good
 * ones already written before it — the same reasoning the batch endpoint's 207
 * follows.
 */
export async function* ndjsonItems(readable, {
  maxItems = MAX_STREAM_ITEMS,
  maxLineBytes = MAX_LINE_BYTES,
  maxBytes = MAX_STREAM_BYTES,
  idleMs = STREAM_IDLE_MS,
} = {}) {
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let bytes = 0;
  let index = 0;

  let timer = null;
  let idle = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = new StreamLimitError("idle", `no data for ${idleMs}ms`, 408);
      // Ends the for-await below. Destroying is the point: an idle client is
      // holding a slot, so the socket goes with it.
      readable.destroy?.(idle);
    }, idleMs);
  };

  // One line, validated and parsed. Returns null for a blank line.
  const take = (line) => {
    const text = line.trim();
    if (!text) return null;
    index += 1;
    if (index > maxItems) {
      throw new StreamLimitError("too_many_items", `publish up to ${maxItems} items in one stream`);
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { index, error: "each line must be a JSON object" };
      }
      return { index, item: parsed };
    } catch {
      return { index, error: "that line is not valid JSON" };
    }
  };

  arm();
  try {
    for await (const chunk of readable) {
      arm();

      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new StreamLimitError("too_large", `a stream may carry up to ${maxBytes} bytes`);
      }

      buffered += decoder.decode(chunk, { stream: true });

      let nl = buffered.indexOf("\n");
      while (nl !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const out = take(line);
        if (out) yield out;
        nl = buffered.indexOf("\n");
      }

      // Checked after draining complete lines, so this only ever measures an
      // unterminated one. Without it a client can send bytes forever with no
      // newline and grow `buffered` without bound — under the total cap the
      // whole time.
      if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) {
        throw new StreamLimitError("line_too_large", `one item may be up to ${maxLineBytes} bytes`);
      }
    }

    buffered += decoder.decode();
    const last = take(buffered);
    if (last) yield last;
  } catch (err) {
    // `readable.destroy(idle)` surfaces here as the error we constructed, but
    // some streams report an aborted read as a generic premature-close instead.
    // Reporting a timeout as a parse failure would send someone looking at
    // their JSON, so the idle flag wins over whatever the stream said.
    throw idle ?? err;
  } finally {
    clearTimeout(timer);
  }
}
