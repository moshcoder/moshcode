// Shaping and formatting for the widget and the panel (PRD 0017).
//
// .pragma library: one copy, no QML context, no access to anything. Everything
// here is a pure function of the snapshot `moshcode omarchy status --json`
// printed, so the two surfaces cannot drift on what "blocked" or "$/h" means.
.pragma library

// The four states the widget has. Blocked outranks everything: it is the only
// one a human can clear, and the only one where the machine is spending a pane
// and a context window on nothing at all.
var UNAVAILABLE = "unavailable";
var BLOCKED = "blocked";
var BUSY = "busy";
var IDLE = "idle";

function parse(text) {
    // A bad parse is a state, not an exception. Anything thrown from here ends
    // up in Omarchy's shared shell process, which is everyone's bar.
    try {
        var snap = JSON.parse(text);
        if (!snap || typeof snap !== "object") return null;
        return snap;
    } catch (e) {
        return null;
    }
}

// The plugin renders a schema it knows and says so about anything newer,
// rather than reading fields that may have moved underneath it.
function supported(snap, schema) {
    return !!snap && snap.schema === schema;
}

function counts(snap) {
    var c = (snap && snap.counts) || {};
    return {
        live: c.live || 0,
        working: c.working || 0,
        blocked: c.blocked || 0,
        idle: c.idle || 0,
        done: c.done || 0
    };
}

function window(snap, key) {
    var rows = (snap && snap.burn) || [];
    for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].key === key) return rows[i];
    }
    return null;
}

function perHour(snap) {
    var row = window(snap, "1h");
    return row && row.perHour !== null && row.perHour !== undefined ? row.perHour : null;
}

function state(snap, staleMs) {
    if (!snap) return UNAVAILABLE;
    if (snap.unavailable) return UNAVAILABLE;
    var c = counts(snap);
    if (c.blocked > 0) return BLOCKED;
    if (c.working > 0 || c.live > 0) return BUSY;
    return IDLE;
}

function stale(snap, now, staleMs) {
    if (!snap || !snap.generatedAt) return false;
    var at = Date.parse(snap.generatedAt);
    if (isNaN(at)) return false;
    return (now - at) > staleMs;
}

function money(value) {
    if (value === null || value === undefined) return "";
    if (value >= 100) return "$" + Math.round(value);
    if (value >= 10) return "$" + value.toFixed(1);
    return "$" + value.toFixed(2);
}

// One line, read at a glance, in the order you care about it: what needs you,
// then what is running, then what it costs.
function label(snap, floor) {
    if (!snap) return "moshcode ?";
    if (snap.unavailable) return "moshcode —";
    var c = counts(snap);
    var parts = [];
    if (c.blocked > 0) parts.push(c.blocked + " blocked");
    parts.push(c.live + " agent" + (c.live === 1 ? "" : "s"));
    var rate = perHour(snap);
    if (rate !== null && rate >= floor) parts.push(money(rate) + "/h");
    return parts.join(" · ");
}

function age(ms) {
    if (ms === null || ms === undefined) return "";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    return h + "h" + (m % 60) + "m";
}

// The cwd matters for telling two `claude` sessions apart, and the head of it
// never does. Keep the tail.
function tail(cwd, keep) {
    if (!cwd) return "";
    var parts = String(cwd).split("/").filter(function (p) { return p.length > 0; });
    if (parts.length <= keep) return cwd;
    return "…/" + parts.slice(parts.length - keep).join("/");
}

function agentLine(agent) {
    var bits = [agent.name, agent.engine, agent.state];
    if (agent.blockedOn) bits[2] = agent.state + ":" + agent.blockedOn;
    return bits.join("  ");
}
