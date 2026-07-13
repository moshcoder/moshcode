// moshscript — an intentionally tiny, readable DSL.
//
// Grammar (that's the whole language):
//   program   := statement*
//   statement := whileStmt | callStmt
//   whileStmt := 'while' '(' IDENT ')' '{' statement* '}'
//   callStmt  := IDENT '(' args? ')' ';'?
//   args      := (STRING | NUMBER | IDENT) (',' ...)*
//   comments  := '//' … end of line   (stripped)
//
// Semantics: `while (alive) { … }` runs its body repeatedly while the `alive`
// flag is truthy, bounded by ctx.maxIterations. Commands run top-to-bottom.

export function tokenize(src) {
  const re = /("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)|(-?\d+(?:\.\d+)?)|([A-Za-z_]\w*)|([(){};,])|(\s+)/g;
  const tokens = [];
  let m;
  let lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== lastIndex) {
      throw new Error(`moshscript: unexpected character near "${src.slice(lastIndex, lastIndex + 12)}"`);
    }
    lastIndex = re.lastIndex;
    if (m[2] || m[6]) continue; // comment or whitespace
    if (m[1]) tokens.push({ t: "str", v: JSON.parse(m[1]) });
    else if (m[3]) tokens.push({ t: "num", v: Number(m[3]) });
    else if (m[4]) tokens.push({ t: "id", v: m[4] });
    else if (m[5]) tokens.push({ t: "punc", v: m[5] });
    else throw new Error(`moshscript: unexpected character near "${src.slice(m.index, m.index + 12)}"`);
  }
  if (lastIndex !== src.length) {
    throw new Error(`moshscript: unexpected character near "${src.slice(lastIndex, lastIndex + 12)}"`);
  }
  return tokens;
}

export function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t, v) => {
    const tok = next();
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`moshscript: expected ${v ?? t}, got ${tok ? JSON.stringify(tok.v) : "end of input"}`);
    }
    return tok;
  };

  function parseStatement() {
    const tok = peek();
    if (!tok) throw new Error("moshscript: unexpected end of input");
    if (tok.t === "id" && tok.v === "while") return parseWhile();
    if (tok.t === "id") return parseCall();
    throw new Error(`moshscript: unexpected ${JSON.stringify(tok.v)}`);
  }
  function parseWhile() {
    expect("id", "while"); expect("punc", "(");
    const cond = expect("id").v;
    expect("punc", ")"); expect("punc", "{");
    const body = [];
    while (peek() && !(peek().t === "punc" && peek().v === "}")) body.push(parseStatement());
    expect("punc", "}");
    return { type: "while", cond, body };
  }
  function parseCall() {
    const name = expect("id").v;
    expect("punc", "(");
    const args = [];
    let expectArg = true;
    while (peek() && !(peek().t === "punc" && peek().v === ")")) {
      const a = next();
      if (a.t === "punc" && a.v === ",") {
        if (expectArg) throw new Error("moshscript: expected argument before comma");
        expectArg = true;
        continue;
      }
      if (!expectArg) throw new Error("moshscript: expected comma between arguments");
      if (a.t === "punc") throw new Error(`moshscript: unexpected ${JSON.stringify(a.v)}`);
      args.push(a.v);
      expectArg = false;
    }
    if (expectArg && args.length) throw new Error("moshscript: expected argument after comma");
    expect("punc", ")");
    if (peek() && peek().t === "punc" && peek().v === ";") next(); // optional ;
    return { type: "call", name, args };
  }

  const body = [];
  while (i < tokens.length) body.push(parseStatement());
  return { type: "program", body };
}

export function compile(src) {
  return parse(tokenize(src));
}

async function exec(node, ctx) {
  if (node.type === "while") {
    while (Boolean(ctx.vars[node.cond]) && ctx.iter < ctx.maxIterations) {
      for (const s of node.body) await exec(s, ctx);
      ctx.iter++;
    }
    return;
  }
  if (node.type === "call") {
    const cmd = ctx.commands[node.name];
    if (!cmd) {
      throw new Error(`moshscript: unknown command ${node.name}(). known: ${Object.keys(ctx.commands).join(", ")}`);
    }
    await cmd(ctx, node.args);
  }
}

export async function run(ast, ctx) {
  for (const stmt of ast.body) await exec(stmt, ctx);
  return ctx;
}
