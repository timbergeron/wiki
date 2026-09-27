const MAX_CHUNK_CHARACTERS = 2800;
const MIN_CHUNK_CHARACTERS = 80;

function pushChunk(chunks, chunk) {
  const body = chunk.body.trim();
  if (body.length < MIN_CHUNK_CHARACTERS && chunks.length) {
    const previous = chunks.at(-1);
    if (previous.body.length + body.length < MAX_CHUNK_CHARACTERS) {
      previous.body = `${previous.body}\n${body}`;
      previous.endLine = chunk.endLine;
      previous.symbols.push(...(chunk.symbols || []));
      return;
    }
  }
  if (!body) return;
  chunks.push({ ...chunk, body, symbols: chunk.symbols || [] });
}

function splitOversized(chunk) {
  if (chunk.body.length <= MAX_CHUNK_CHARACTERS) return [chunk];
  const lines = chunk.body.split("\n");
  const parts = [];
  let buffer = [];
  let length = 0;
  let startLine = chunk.startLine;
  let cursor = chunk.startLine;
  for (const line of lines) {
    if (length + line.length > MAX_CHUNK_CHARACTERS && buffer.length) {
      parts.push({
        ...chunk,
        body: buffer.join("\n"),
        startLine,
        endLine: cursor - 1,
        symbols: parts.length ? [] : chunk.symbols,
      });
      buffer = [];
      length = 0;
      startLine = cursor;
    }
    buffer.push(line);
    length += line.length + 1;
    cursor += 1;
  }
  if (buffer.length) {
    parts.push({
      ...chunk,
      body: buffer.join("\n"),
      startLine,
      endLine: chunk.endLine,
      symbols: parts.length ? [] : chunk.symbols,
    });
  }
  return parts;
}

const CVAR_DECLARATION = /^\s*(?:static\s+)?cvar_t\s+([A-Za-z_][\w]*)\s*=\s*\{\s*"([^"]+)"\s*(?:,\s*"([^"]*)")?/;
const COMMAND_REGISTRATION = /Cmd_AddCommand\s*\(\s*"([^"]+)"/g;
const FUNCTION_SIGNATURE = /^([A-Za-z_][\w \t*]*?)\b([A-Za-z_]\w*)\s*\(/;

function cSymbolsForLine(line) {
  const symbols = [];
  const cvar = CVAR_DECLARATION.exec(line);
  if (cvar) {
    symbols.push({
      name: cvar[2],
      kind: "cvar",
      weight: 1,
      detail: cvar[3] === undefined ? "" : `default "${cvar[3]}"`,
    });
    if (cvar[1] !== cvar[2]) {
      symbols.push({ name: cvar[1], kind: "cvar-variable", weight: 0.6, detail: "" });
    }
  }
  for (const match of line.matchAll(COMMAND_REGISTRATION)) {
    symbols.push({ name: match[1], kind: "command", weight: 1, detail: "" });
  }
  return symbols;
}

function isFunctionStart(lines, index) {
  const line = lines[index];
  if (!line || /^[\s#}]/.test(line) || line.startsWith("//") || line.startsWith("*")) return false;
  if (!FUNCTION_SIGNATURE.test(line)) return false;
  if (/;\s*$/.test(line)) return false;
  for (let ahead = index; ahead < Math.min(index + 4, lines.length); ahead += 1) {
    if (lines[ahead].startsWith("{")) return true;
  }
  return false;
}

function bannerStart(lines, index) {
  let start = index;
  while (start > 0) {
    const previous = lines[start - 1];
    if (previous === "" && start - 1 > 0 && lines[start - 2]?.startsWith("*/")) {
      start -= 1;
      continue;
    }
    if (/^[\s]*(\/\*|\*|\*\/|\/\/)/.test(previous)) {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

const PREAMBLE_CHARACTERS = 900;

function isLicenseBanner(lines, start, end) {
  if (!lines[start]?.trimStart().startsWith("/*")) return false;
  for (let index = start; index < end; index += 1) {
    if (/copyright|free software foundation|GNU General Public/i.test(lines[index])) return true;
    if (lines[index].includes("*/")) return false;
  }
  return false;
}

function skipLicenseBanner(lines, start, end) {
  if (!isLicenseBanner(lines, start, end)) return start;
  for (let index = start; index < end; index += 1) {
    if (lines[index].includes("*/")) return index + 1;
  }
  return start;
}

// Declarations and includes sit above the first function. Keeping that region as one
// chunk buries `cvar_t` declarations under the license banner, so split it into small
// blocks that a symbol lookup can land on directly.
function chunkPreamble(lines, start, end) {
  const chunks = [];
  let buffer = [];
  let length = 0;
  let blockStart = start;

  const flush = (endLine) => {
    if (!buffer.length) return;
    const body = buffer.join("\n");
    chunks.push({
      heading: "",
      body,
      startLine: blockStart + 1,
      endLine,
      symbols: buffer.flatMap(cSymbolsForLine),
    });
    buffer = [];
    length = 0;
  };

  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() && length > PREAMBLE_CHARACTERS) {
      flush(index);
      blockStart = index + 1;
      continue;
    }
    if (!buffer.length) blockStart = index;
    buffer.push(line);
    length += line.length + 1;
  }
  flush(end);
  return chunks;
}

export function chunkCSource(text) {
  const lines = text.split("\n");
  const boundaries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isFunctionStart(lines, index)) {
      const start = bannerStart(lines, index);
      const heading = FUNCTION_SIGNATURE.exec(lines[index])?.[2] || "";
      if (!boundaries.length || start > boundaries.at(-1).start) {
        boundaries.push({ start, heading });
      }
    }
  }
  if (!boundaries.length || boundaries[0].start > 0) {
    boundaries.unshift({ start: 0, heading: "" });
  }

  const chunks = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index].start;
    const end = index + 1 < boundaries.length ? boundaries[index + 1].start : lines.length;

    if (!boundaries[index].heading) {
      const bodyStart = skipLicenseBanner(lines, start, end);
      for (const chunk of chunkPreamble(lines, bodyStart, end)) pushChunk(chunks, chunk);
      continue;
    }

    const slice = lines.slice(start, end);
    const symbols = [];
    if (boundaries[index].heading) {
      symbols.push({ name: boundaries[index].heading, kind: "function", weight: 0.85, detail: "" });
    }
    for (const line of slice) symbols.push(...cSymbolsForLine(line));
    pushChunk(chunks, {
      heading: boundaries[index].heading,
      body: slice.join("\n"),
      startLine: start + 1,
      endLine: end,
      symbols,
    });
  }
  return chunks.flatMap(splitOversized);
}

export function chunkMarkdown(text) {
  const lines = text.split("\n");
  const chunks = [];
  let heading = "";
  let buffer = [];
  let startLine = 1;

  const flush = (endLine) => {
    if (!buffer.length) return;
    pushChunk(chunks, {
      heading,
      body: buffer.join("\n"),
      startLine,
      endLine,
      symbols: heading ? [{ name: heading, kind: "heading", weight: 0.5, detail: "" }] : [],
    });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (match) {
      flush(index);
      heading = match[2].trim();
      startLine = index + 1;
    }
    buffer.push(lines[index]);
  }
  flush(lines.length);
  return chunks.flatMap(splitOversized);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

export function htmlToMarkdown(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, inner) =>
      `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, " ").trim()}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z#0-9]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkHtmlDocument(text) {
  return chunkMarkdown(htmlToMarkdown(text));
}

export function chunkPlainText(text) {
  const blocks = text.split(/\n{2,}/);
  const chunks = [];
  let line = 1;
  for (const block of blocks) {
    const height = block.split("\n").length;
    pushChunk(chunks, {
      heading: "",
      body: block,
      startLine: line,
      endLine: line + height - 1,
      symbols: [],
    });
    line += height + 1;
  }
  return chunks.flatMap(splitOversized);
}

const BY_EXTENSION = new Map([
  [".c", chunkCSource],
  [".h", chunkCSource],
  [".m", chunkCSource],
  [".qc", chunkCSource],
  [".md", chunkMarkdown],
  [".markdown", chunkMarkdown],
  [".html", chunkHtmlDocument],
  [".htm", chunkHtmlDocument],
]);

const BY_NAME = new Map([
  ["c-source", chunkCSource],
  ["markdown", chunkMarkdown],
  ["html-doc", chunkHtmlDocument],
  ["text", chunkPlainText],
]);

export function pickChunker(extractor, filePath) {
  if (extractor && extractor !== "auto") {
    const chunker = BY_NAME.get(extractor);
    if (!chunker) throw new Error(`Unknown extractor "${extractor}"`);
    return chunker;
  }
  const dot = filePath.lastIndexOf(".");
  const extension = dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  return BY_EXTENSION.get(extension) || chunkPlainText;
}
