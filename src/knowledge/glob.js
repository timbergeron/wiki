const SPECIAL = /[.+^${}()|[\]\\]/g;

function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    else if (pattern[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        const head = pattern.slice(0, open);
        const tail = pattern.slice(index + 1);
        const options = splitTopLevel(pattern.slice(open + 1, index));
        return options.flatMap((option) => expandBraces(`${head}${option}${tail}`));
      }
    }
  }
  return [pattern];
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function toRegExpSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const slashed = pattern[index + 2] === "/";
        source += slashed ? "(?:.*/)?" : ".*";
        index += slashed ? 2 : 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(SPECIAL, "\\$&");
  }
  return source;
}

export function compileGlobs(patterns) {
  const expressions = patterns
    .flatMap(expandBraces)
    .map((pattern) => new RegExp(`^${toRegExpSource(pattern)}$`));
  return (candidate) => expressions.some((expression) => expression.test(candidate));
}

export function matchesGlob(candidate, pattern) {
  return compileGlobs([pattern])(candidate);
}
