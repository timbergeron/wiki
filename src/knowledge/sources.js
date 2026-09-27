import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { csvToRecords } from "./csv.js";
import { pickChunker } from "./extractors.js";
import { compileGlobs } from "./glob.js";
import { resolveContainedPath, resolveSourcePath } from "./manifest.js";

const run = promisify(execFile);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

async function git(root, args) {
  const { stdout } = await run("git", ["-C", root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function repositoryRevision(root, ref = "HEAD", { includeDirty = false } = {}) {
  const [hash, branch, dirty] = await Promise.all([
    git(root, ["rev-parse", "--short", ref]).then((value) => value.trim()).catch(() => ""),
    git(root, ["rev-parse", "--abbrev-ref", ref]).then((value) => value.trim()).catch(() => ""),
    includeDirty
      ? git(root, ["status", "--porcelain", "--untracked-files=no"])
        .then((value) => Boolean(value.trim())).catch(() => false)
      : false,
  ]);
  const label = branch && branch !== "HEAD" ? `${branch}@${hash}` : hash;
  return dirty ? `${label}+dirty` : label;
}

function documentUrl(source, { relativePath, revision, startLine }) {
  if (!source.urlTemplate) return "";
  return source.urlTemplate
    .replaceAll("{path}", relativePath || "")
    .replaceAll("{revision}", (revision || "").split("@").pop().replace(/\+dirty$/, ""))
    .replaceAll("{startLine}", String(startLine || 1));
}

async function readTextFile(absolutePath) {
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return "";
  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) return "";
  return buffer.toString("utf8");
}

async function chunkFiles(source, { root, relativePaths, revision, logger }) {
  const documents = [];
  let sourceBytes = 0;
  for (const relativePath of relativePaths) {
    let text = "";
    try {
      const safePath = await resolveContainedPath(root, relativePath, `${source.id}:${relativePath}`);
      text = await readTextFile(safePath);
    } catch (error) {
      logger?.warn?.(`Skipped ${relativePath}: ${error.message}`);
      continue;
    }
    if (!text.trim()) continue;
    const textBytes = Buffer.byteLength(text);
    if (sourceBytes + textBytes > MAX_SOURCE_BYTES) {
      logger?.warn?.(
        `Stopped ${source.id} after ${MAX_SOURCE_BYTES} bytes; narrow its include patterns`,
      );
      break;
    }
    sourceBytes += textBytes;

    const chunker = pickChunker(source.extractor, relativePath);
    const base = path.basename(relativePath);
    const chunks = chunker(text).map((chunk) => ({
      ...chunk,
      symbols: [...chunk.symbols, { name: base, kind: "file", weight: 0.5, detail: "" }],
    }));
    if (!chunks.length) continue;

    documents.push({
      kind: source.kind,
      locator: relativePath,
      title: relativePath,
      revision,
      url: documentUrl(source, { relativePath, revision, startLine: 1 }),
      chunks,
    });
  }
  return documents;
}

async function collectGitWorktree(source, context) {
  const root = await resolveSourcePath(source, context);
  const revision = await repositoryRevision(root, source.ref || "HEAD", { includeDirty: true });
  const listing = await git(root, ["ls-files", "-z"]);
  const include = compileGlobs(source.include);
  const exclude = source.exclude.length ? compileGlobs(source.exclude) : () => false;

  const relativePaths = listing
    .split("\0")
    .filter(Boolean)
    .filter((candidate) => include(candidate) && !exclude(candidate))
    .slice(0, MAX_FILES);

  return {
    revision,
    documents: await chunkFiles(source, { ...context, root, relativePaths, revision }),
  };
}

async function walkDirectory(root, current = "", found = []) {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkDirectory(root, relativePath, found);
    else if (entry.isFile()) found.push(relativePath);
    if (found.length >= MAX_FILES) break;
  }
  return found;
}

async function collectFiles(source, context) {
  const root = await resolveSourcePath(source, context);
  const include = compileGlobs(source.include.length ? source.include : ["**"]);
  const exclude = source.exclude.length ? compileGlobs(source.exclude) : () => false;
  const relativePaths = (await walkDirectory(root))
    .filter((candidate) => include(candidate) && !exclude(candidate));
  return {
    revision: "",
    documents: await chunkFiles(source, { ...context, root, relativePaths, revision: "" }),
  };
}

async function collectGitHistory(source, context) {
  const root = await resolveSourcePath(source, context);
  const revision = await repositoryRevision(root, source.ref);
  const format = "%x1e%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1f%b%x1f";
  const log = await git(root, [
    "log",
    source.ref,
    `-n${source.maxCommits}`,
    "--date=short",
    `--format=format:${format}`,
    "--name-only",
  ]);

  const documents = [];
  for (const record of log.split(RECORD_SEPARATOR)) {
    if (!record.trim()) continue;
    const fields = record.split(UNIT_SEPARATOR);
    const [full, short, date, author, subject, body = ""] = fields;
    if (!short) continue;
    const files = (fields[6] || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 40);

    const heading = `${short} ${subject}`;
    const text = [
      `commit ${short} (${date}) by ${author}`,
      subject,
      body.trim(),
      files.length ? `Files: ${files.join(", ")}` : "",
    ].filter(Boolean).join("\n");

    documents.push({
      kind: source.kind,
      locator: `commit ${short}`,
      title: heading,
      revision: date,
      url: documentUrl(source, { relativePath: "", revision: full, startLine: 1 }),
      chunks: [{
        heading,
        body: text.slice(0, 4000),
        startLine: null,
        endLine: null,
        symbols: [
          { name: short, kind: "commit", weight: 1, detail: date },
          ...files.map((file) => ({
            name: path.basename(file),
            kind: "file",
            weight: 0.35,
            detail: "",
          })),
        ],
      }],
    });
  }
  return { revision, documents };
}

function splitIdentifiers(raw) {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return { identifiers: [], defaultValue: "" };
  const defaultMatch = /"([^"]*)"\s*$/.exec(cleaned);
  const withoutDefault = defaultMatch ? cleaned.slice(0, defaultMatch.index).trim() : cleaned;
  const identifiers = [...new Set(withoutDefault
    .split(/[,/]/)
    .map((part) => part.trim().replace(/^\*/, ""))
    .filter((part) => /^[+-]?[A-Za-z_][\w.+-]*$/.test(part)))];
  return { identifiers, defaultValue: defaultMatch ? defaultMatch[1] : "" };
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateAddress(normalized.slice("::ffff:".length));
    }
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized);
  }
  return true;
}

export async function assertPublicHttpsUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("remote CSV URLs must use HTTPS without credentials");
  }
  if (url.port && url.port !== "443") {
    throw new Error("remote CSV URLs must use the default HTTPS port");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`remote CSV host ${hostname} is not public`);
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`remote CSV host ${hostname} resolves to a non-public address`);
  }
  return url;
}

async function fetchPublicCsv(value) {
  let url = new URL(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpsUrl(url);
    const response = await fetch(url, {
      headers: { Accept: "text/csv,text/plain" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${url} redirected without a location`);
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`${url} returned more than ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`${url} returned more than ${MAX_DOWNLOAD_BYTES} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }
  throw new Error(`${value} redirected more than ${MAX_REDIRECTS} times`);
}

async function loadCsvText(source, context) {
  if (!source.url) {
    const file = await resolveSourcePath(source, context);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`local CSV must be a file no larger than ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    return readFile(file, "utf8");
  }
  return fetchPublicCsv(source.url);
}

async function collectCsvCatalog(source, context) {
  const text = await loadCsvText(source, context);
  const { records } = csvToRecords(text);
  const columns = source.columns;
  const documents = [];

  for (const record of records) {
    const rawIdentifier = record.get(...columns.identifier);
    const type = record.get(...columns.type);
    const engine = record.get(...columns.engine);
    if (!rawIdentifier) continue;
    if (type.toLowerCase() === "type" || engine.toLowerCase() === "engine") continue;

    const { identifiers, defaultValue } = splitIdentifiers(rawIdentifier);
    if (!identifiers.length) continue;

    const description = record.get(...columns.description);
    const summary = record.get(...columns.summary);
    const category = record.get(...columns.category);
    if (!description && !summary) continue;

    const heading = identifiers.join(", ");
    const facts = [
      engine ? `Engine: ${engine}` : "",
      type ? `Type: ${type}` : "",
      category ? `Category: ${category}` : "",
      defaultValue !== "" ? `Default: "${defaultValue}"` : "",
    ].filter(Boolean).join(" | ");

    documents.push({
      kind: source.kind,
      locator: `${source.label} row ${record.line}`,
      title: heading,
      revision: engine,
      url: source.url,
      chunks: [{
        heading,
        body: [heading, facts, summary, description].filter(Boolean).join("\n").slice(0, 4000),
        startLine: record.line,
        endLine: record.line,
        symbols: identifiers.map((identifier) => ({
          name: identifier,
          kind: type.toLowerCase() === "command" ? "command" : "cvar",
          weight: 1,
          detail: [engine, defaultValue !== "" ? `default "${defaultValue}"` : ""]
            .filter(Boolean)
            .join(" "),
        })),
      }],
    });
  }
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { revision: `sha256:${digest}`, documents };
}

const ADAPTERS = {
  "git-worktree": collectGitWorktree,
  "git-history": collectGitHistory,
  files: collectFiles,
  csv: collectCsvCatalog,
};

export async function collectSource(source, context) {
  const adapter = ADAPTERS[source.type];
  if (!adapter) throw new Error(`Unsupported source type "${source.type}"`);
  return adapter(source, { logger: console, env: process.env, ...context });
}
