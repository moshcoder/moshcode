// Friendly trading vocabulary over Alpaca's native CLI.
//
// Alpaca remains a workflow tool: authentication, API calls, structured output,
// and the full command tree all belong to the `alpaca` binary. This module only
// translates a small, memorable `moshcode trade` surface into native argv.
// `moshcode alpaca ...` remains the escape hatch for every command not covered
// here.

const USAGE = `usage: moshcode trade <command> [args…]

  ticker <symbol> [flags…]        look up a tradable asset
  quote <symbol> [flags…]         get the latest quote
  analysis <symbol> [flags…]      get an analysis-ready market snapshot
  buy <symbol> <qty> [flags…]     preview a buy; add --submit to place it
  buy <symbol> --notional <usd>    preview a dollar-value buy
  sell <symbol> <qty> [flags…]    preview a sell; add --submit to place it
  watch <verb> [args…]            manage Alpaca watchlists
  positions [verb] [args…]        list/get/close positions
  orders [verb] [args…]           list/get/replace/cancel orders
  account [args…]                 show account details
  login [args…]                   authenticate an Alpaca profile (paper by default)
  clock [args…]                   show market status and next open/close
  raw <alpaca args…>              invoke the native Alpaca command tree

Orders are previews by default. --submit removes the injected --dry-run;
live trading still requires Alpaca's separate --live opt-in.`;

export function tradeUsage() {
  return USAGE;
}

function symbolCommand(native, args) {
  const [symbol, ...rest] = args;
  if (!symbol || String(symbol).startsWith("-")) {
    return { error: `trade ${native.label} requires a ticker symbol` };
  }
  return { args: [...native.argv, "--symbol", String(symbol).toUpperCase(), ...rest] };
}

function optionValue(args, name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return { value: args[exact + 1], missing: args[exact + 1] == null || String(args[exact + 1]).startsWith("-") };
  const prefix = `${name}=`;
  const joined = args.find((arg) => String(arg).startsWith(prefix));
  return joined == null ? null : { value: String(joined).slice(prefix.length), missing: String(joined).slice(prefix.length) === "" };
}

function positiveNumber(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0;
}

function orderCommand(side, args) {
  const [symbol, ...afterSymbol] = args;
  if (!symbol || String(symbol).startsWith("-")) {
    return { error: `trade ${side} requires a ticker symbol and quantity or --notional` };
  }

  const positionalQty = afterSymbol[0] != null && !String(afterSymbol[0]).startsWith("-")
    ? String(afterSymbol[0])
    : null;
  const tail = positionalQty == null ? afterSymbol : afterSymbol.slice(1);
  const qtyOption = optionValue(tail, "--qty");
  const notionalOption = optionValue(tail, "--notional");
  const supplied = [positionalQty != null, qtyOption != null, notionalOption != null].filter(Boolean).length;
  if (supplied === 0) {
    return { error: `trade ${side} requires a positive quantity or --notional amount` };
  }
  if (supplied > 1) {
    return { error: `trade ${side} accepts one of positional quantity, --qty, or --notional` };
  }
  if (qtyOption?.missing) return { error: `trade ${side} --qty requires a positive number` };
  if (notionalOption?.missing) return { error: `trade ${side} --notional requires a positive number` };
  const amount = positionalQty ?? qtyOption?.value ?? notionalOption?.value;
  if (!positiveNumber(amount)) {
    return { error: `trade ${side} ${notionalOption ? "notional amount" : "quantity"} must be a positive number` };
  }

  // Placing an order is the one place where a friendly shortcut should be
  // safer than its native equivalent. Alpaca deliberately has no confirmation
  // prompts, so buy/sell previews unless the caller explicitly says --submit.
  const submit = tail.includes("--submit");
  const nativeTail = tail.filter((arg) => arg !== "--submit");
  const hasType = nativeTail.some((arg) => arg === "--type" || String(arg).startsWith("--type="));
  const hasDryRun = nativeTail.includes("--dry-run");
  return {
    args: [
      "order", "submit",
      "--symbol", String(symbol).toUpperCase(),
      "--side", side,
      ...(positionalQty == null ? [] : ["--qty", positionalQty]),
      ...(hasType ? [] : ["--type", "market"]),
      ...nativeTail,
      ...(!submit && !hasDryRun ? ["--dry-run"] : []),
    ],
    preview: !submit || hasDryRun,
  };
}

/** Translate `trade` arguments into argv for the native `alpaca` binary. */
export function tradeArgs(input = []) {
  const [rawCommand, ...rest] = input.map(String);
  const command = rawCommand?.toLowerCase();
  if (!command) return { usage: true };

  if (command === "ticker" || command === "lookup" || command === "asset") {
    const [symbol, ...tail] = rest;
    if (!symbol || String(symbol).startsWith("-")) return { error: "trade ticker requires a ticker symbol" };
    // Unlike market-data commands, Alpaca asset get names its lookup argument
    // --symbol-or-asset-id (verified against v0.0.13's actual command tree).
    return { args: ["asset", "get", "--symbol-or-asset-id", String(symbol).toUpperCase(), ...tail] };
  }
  if (command === "quote") {
    return symbolCommand({ label: "quote", argv: ["data", "latest-quote"] }, rest);
  }
  if (command === "analysis" || command === "analyze") {
    return symbolCommand({ label: "analysis", argv: ["data", "snapshot"] }, rest);
  }
  if (command === "buy" || command === "sell") return orderCommand(command, rest);

  if (command === "watch" || command === "watchlist") {
    return { args: ["watchlist", ...(rest.length ? rest : ["list"])] };
  }
  if (command === "positions" || command === "position") {
    return { args: ["position", ...(rest.length ? rest : ["list"])] };
  }
  if (command === "orders" || command === "order") {
    return { args: ["order", ...(rest.length ? rest : ["list"])] };
  }
  if (command === "account") return { args: ["account", ...(rest.length ? rest : ["get"])] };
  if (command === "login") return { args: ["profile", "login", ...rest] };
  if (command === "clock") return { args: ["clock", ...rest] };
  if (command === "raw" || command === "alpaca") {
    return rest.length ? { args: rest } : { error: "trade raw requires an Alpaca command" };
  }

  return { error: `unknown trade command ${JSON.stringify(rawCommand)}` };
}
