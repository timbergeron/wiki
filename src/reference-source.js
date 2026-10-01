// A small source scanner, not a C compiler. Preserve unknown build conditions,
// but evaluate platform guards so defaults never depend on the first #if branch.
export const PLATFORMS = ["linux", "windows", "macos"];

export function stripComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (part) => part.startsWith("//") || part.startsWith("/*") ? part.replace(/[^\n\r]/g, " ") : part);
}

function condition(expression, macros, platform) {
  const known = { _WIN32: platform === "windows", WIN32: platform === "windows", __APPLE__: platform === "macos", __linux__: platform === "linux", QSS_DATE: false };
  let text = expression.trim().replace(/defined\s*(?:\(\s*(\w+)\s*\)|(\w+))/g, (_, a, b) => {
    const name = a || b;
    return name in known ? String(Number(known[name])) : macros.has(name) ? "1" : "?";
  });
  text = text.replace(/\b[A-Za-z_]\w*\b/g, (name) => name in known ? String(Number(known[name])) : /^\d+$/.test(macros.get(name) || "") ? macros.get(name) : "?");
  // Unrecognized arithmetic/build guards remain in the catalog for review.
  if (!/^[\s01!()&|]+$/.test(text)) return null;
  const tokens = text.match(/&&|\|\||[!()01]/g) || [];
  let position = 0;
  const atom = () => {
    const token = tokens[position++];
    if (token === "!") return !atom();
    if (token === "(") { const value = or(); if (tokens[position++] !== ")") throw new Error(); return value; }
    if (token !== "0" && token !== "1") throw new Error();
    return token === "1";
  };
  const and = () => { let value = atom(); while (tokens[position] === "&&") { position++; const next = atom(); value = value && next; } return value; };
  const or = () => { let value = and(); while (tokens[position] === "||") { position++; const next = and(); value = value || next; } return value; };
  try { const value = or(); return position === tokens.length ? value : null; } catch { return null; }
}

function preprocess(text, platform, inherited = new Map()) {
  const macros = new Map(inherited);
  const guards = [];
  const active = () => guards.every((guard) => guard.current !== false);
  const lines = stripComments(text).split("\n");
  let continuationEnd = -1;
  const code = lines.map((line, index) => {
    if (index <= continuationEnd) return " ".repeat(line.length);
    let logical = line.replace(/\r$/, "");
    if (/^\s*#/.test(logical)) {
      let end = index;
      while (logical.endsWith("\\") && end + 1 < lines.length) logical = logical.slice(0, -1) + " " + lines[++end].replace(/\r$/, "");
      continuationEnd = end;
    }
    const directive = logical.match(/^\s*#\s*(\w+)\s*(.*)$/);
    if (!directive) return active() ? line : " ".repeat(line.length);
    const [, name, argument] = directive;
    if (["if", "ifdef", "ifndef"].includes(name)) {
      const expression = name === "if" ? argument : `${name === "ifndef" ? "!" : ""}defined(${argument.trim()})`;
      const value = condition(expression, macros, platform);
      guards.push({ current: value, taken: value });
    } else if (name === "else" || name === "elif") {
      const guard = guards.at(-1);
      if (guard) {
        const next = name === "else" ? true : condition(argument, macros, platform);
        guard.current = guard.taken === true ? false : guard.taken === null ? null : next;
        guard.taken = guard.taken === true || next === true ? true : guard.taken === null || next === null ? null : false;
      }
    } else if (name === "endif") {
      guards.pop();
    } else if (active() && name === "define") {
      const definition = argument.match(/^(\w+)(\([^)]*\))?\s*(.*)$/);
      if (definition) macros.set(definition[1], definition[2] ? { parameters: definition[2].slice(1, -1).split(",").map((p) => p.trim()), body: definition[3] } : definition[3]);
    } else if (active() && name === "undef") macros.delete(argument.trim());
    return " ".repeat(line.length);
  }).join("\n");
  return { code, macros };
}

function expand(expression, macros, depth = 0) {
  if (depth > 24) throw new Error("Recursive macro");
  return expression.replace(/"(?:\\.|[^"\\])*"|\b([A-Za-z_]\w*)(?:\s*\(([^()]*)\))?/g, (token, name, argumentsText) => {
    if (!name || !macros.has(name)) return token;
    const macro = macros.get(name);
    if (typeof macro === "string") return expand(macro, macros, depth + 1);
    if (argumentsText === undefined) return token;
    const argumentsList = argumentsText.split(",").map((part) => part.trim());
    let body = macro.body;
    macro.parameters.forEach((parameter, index) => {
      const argument = argumentsList[index] || "";
      body = body.replace(new RegExp(`"(?:\\\\.|[^"\\\\])*"|(#\\s*)?\\b${parameter}\\b`, "g"), (part, stringify) =>
        part.startsWith('"') ? part : stringify ? JSON.stringify(argument) : expand(argument, macros, depth + 1));
    });
    return expand(body, macros, depth + 1);
  });
}

function stringValue(expression, macros) {
  let expanded;
  try { expanded = expand(expression, macros); } catch { return null; }
  if (!/^\s*(?:"(?:\\.|[^"\\])*"\s*)+$/.test(expanded)) return null;
  return [...expanded.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1].replace(/\\(x[0-9a-f]+|[0-7]{1,3}|.)/gi, (_, escape) => {
    if (escape.startsWith("x")) return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", a: "\x07" })[escape] ?? escape;
  })).join("");
}

function fields(text) {
  const result = [];
  let start = 0, depth = 0;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}()[\],]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if ("{([".includes(token)) depth++;
    else if ("})]".includes(token)) depth--;
    else if (token === "," && depth === 0) { result.push(text.slice(start, match.index).trim()); start = match.index + 1; }
  }
  result.push(text.slice(start).trim());
  return result;
}

function initializer(code, offset) {
  let depth = 1;
  for (const match of code.slice(offset).matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{}]/g)) {
    if (match[0] === "{") depth++;
    if (match[0] === "}" && --depth === 0) return code.slice(offset, offset + match.index);
  }
  return "";
}

export function scanCvars(text, { header = "", file = "" } = {}) {
  const variants = new Map();
  for (const platform of PLATFORMS) {
    const { macros: inherited } = preprocess(header, platform);
    const { code, macros } = preprocess(text, platform, inherited);
    for (const declaration of code.matchAll(/\bcvar_t\s+\w+\s*(\[[^\]]*\])?\s*=\s*\{/g)) {
      const offset = declaration.index + declaration[0].length;
      const body = initializer(code, offset);
      const members = declaration[1] ? fields(body).filter((member) => member.startsWith("{")).map((member) => ({ body: member.slice(1, -1), offset: code.indexOf(member, offset) })) : [{ body, offset: declaration.index }];
      for (const member of members) {
        const [identifier, value = "", flags = ""] = fields(member.body);
        const name = stringValue(identifier, macros);
        if (!name) continue;
        const entry = { name, kind: "cvar", default: stringValue(value, macros), defaultExpression: value, flagExpression: flags, file, line: code.slice(0, member.offset).split("\n").length };
        if (!variants.has(name)) variants.set(name, new Map());
        const previous = variants.get(name).get(platform);
        if (previous && previous.default !== entry.default) {
          entry.defaultExpression = `${previous.defaultExpression} or ${value}`;
          entry.default = null;
          entry.flagExpression += ` ${previous.flagExpression}`;
        }
        variants.get(name).set(platform, entry);
      }
    }
  }
  return [...variants.values()].map((platforms) => {
    const selected = platforms.get("linux") || platforms.values().next().value;
    const entry = { name: selected.name, kind: selected.kind, default: selected.default, flags: [], file: selected.file, line: selected.line };
    const defaults = Object.fromEntries([...platforms].map(([platform, item]) => [platform, item.default]));
    if (new Set(Object.values(defaults)).size > 1) entry.defaultByPlatform = defaults;
    if (entry.default === null) entry.defaultExpression = selected.defaultExpression;
    const flagText = [...platforms.values()].map((item) => item.flagExpression).join(" ");
    if (/CVAR_ARCHIVE|CVAR_SETA|\btrue\b/.test(flagText)) entry.flags.push("saved");
    for (const [flag, label] of [["SERVERINFO", "serverinfo"], ["USERINFO", "userinfo"], ["ROM", "read-only"], ["NOTIFY", "notify"]]) if (flagText.includes(`CVAR_${flag}`)) entry.flags.push(label);
    return entry;
  });
}
