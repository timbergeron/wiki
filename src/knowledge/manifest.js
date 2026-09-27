import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = 1;

const SOURCE_TYPES = new Set(["git-worktree", "git-history", "files", "csv"]);
const EXTRACTORS = new Set([
  "auto",
  "c-source",
  "markdown",
  "html-doc",
  "text",
  "command-catalog",
  "git-log",
]);
const ACTIVATION_MODES = new Set(["auto", "always"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

function fail(packId, message) {
  throw new ManifestError(`${packId || "pack"}: ${message}`);
}

function stringList(value, packId, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(packId, `${field} must be an array of strings`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      fail(packId, `${field} must contain non-empty strings`);
    }
    return item.trim();
  });
}

function boundedNumber(value, { fallback, min, max, packId, field }) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    fail(packId, `${field} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function booleanValue(value, fallback, packId, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(packId, `${field} must be true or false`);
  return value;
}

function validateHttpsTemplate(value, packId, field) {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value
      .replaceAll("{path}", "path")
      .replaceAll("{revision}", "revision")
      .replaceAll("{startLine}", "1"));
  } catch {
    fail(packId, `${field} must be a valid URL template`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(packId, `${field} must be an https URL without credentials`);
  }
}

function validateGitRef(value, packId, sourceId) {
  if (
    !GIT_REF_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) {
    fail(packId, `source "${sourceId}" has an unsafe git ref`);
  }
}

const CATALOG_FIELDS = [
  "identifier",
  "engine",
  "category",
  "type",
  "description",
  "summary",
];

function normalizeColumns(raw, packId, sourceId) {
  const columns = {};
  for (const field of CATALOG_FIELDS) {
    const value = raw?.[field];
    const headers = value === undefined
      ? []
      : stringList(Array.isArray(value) ? value : [value], packId, `source "${sourceId}" columns.${field}`);
    columns[field] = headers;
  }
  if (!columns.identifier.length) {
    fail(packId, `source "${sourceId}" needs columns.identifier`);
  }
  if (!columns.description.length && !columns.summary.length) {
    fail(packId, `source "${sourceId}" needs columns.description or columns.summary`);
  }
  return columns;
}

function normalizeMount(raw, packId, sourceId) {
  const mount = String(raw.mount || "").trim();
  if (mount && !ID_PATTERN.test(mount)) {
    fail(packId, `source "${sourceId}" mount must be kebab-case`);
  }
  return mount;
}

function normalizeSource(raw, packId, seen) {
  if (!raw || typeof raw !== "object") fail(packId, "each source must be an object");
  const id = String(raw.id || "").trim();
  if (!ID_PATTERN.test(id)) fail(packId, `source id "${id}" must be kebab-case`);
  if (seen.has(id)) fail(packId, `duplicate source id "${id}"`);
  seen.add(id);

  const type = String(raw.type || "").trim();
  if (!SOURCE_TYPES.has(type)) {
    fail(packId, `source "${id}" has unknown type "${type}"`);
  }

  const extractor = String(raw.extractor || "auto").trim();
  if (!EXTRACTORS.has(extractor)) {
    fail(packId, `source "${id}" has unknown extractor "${extractor}"`);
  }

  const kind = String(raw.kind || "").trim() || defaultKind(type);
  if (!KIND_PATTERN.test(kind)) fail(packId, `source "${id}" has an invalid kind`);
  const urlTemplate = String(raw.urlTemplate || "").trim();
  validateHttpsTemplate(urlTemplate, packId, `source "${id}" urlTemplate`);

  const source = {
    id,
    type,
    extractor,
    kind,
    label: String(raw.label || "").trim().slice(0, 120) || id,
    authority: boundedNumber(raw.authority, {
      fallback: 0.8,
      min: 0,
      max: 1,
      packId,
      field: `source "${id}" authority`,
    }),
    include: stringList(raw.include, packId, `source "${id}" include`),
    exclude: stringList(raw.exclude, packId, `source "${id}" exclude`),
    urlTemplate,
  };

  if (raw.pathEnv !== undefined) {
    fail(packId, `source "${id}" uses removed field pathEnv; use mount instead`);
  }

  const mount = normalizeMount(raw, packId, id);
  const localPath = String(raw.path || "").trim();
  if (localPath.includes("\0")) fail(packId, `source "${id}" path contains a null byte`);

  if (type === "csv") {
    const url = String(raw.url || "").trim();
    if (!url && !localPath && !mount) fail(packId, `source "${id}" needs a url, path, or mount`);
    if (url && (localPath || mount)) {
      fail(packId, `source "${id}" must use either url or local path/mount, not both`);
    }
    if (url) validateHttpsTemplate(url, packId, `source "${id}" url`);
    source.url = url;
    source.mount = mount;
    source.path = localPath || (mount ? "." : "");
    source.columns = normalizeColumns(raw.columns, packId, id);
    return source;
  }

  if (!localPath && !mount) fail(packId, `source "${id}" needs path or mount`);
  source.mount = mount;
  source.path = localPath || ".";
  if (type === "git-worktree" && !source.include.length) {
    fail(packId, `source "${id}" needs at least one include pattern`);
  }
  if (type === "git-worktree") {
    source.ref = String(raw.ref || "HEAD").trim();
    if (source.ref !== "HEAD") {
      fail(packId, `source "${id}" git-worktree ref must be HEAD; check out the desired revision`);
    }
  }
  if (type === "git-history") {
    source.ref = String(raw.ref || "HEAD").trim();
    validateGitRef(source.ref, packId, id);
    source.maxCommits = Math.floor(boundedNumber(raw.maxCommits, {
      fallback: 2000,
      min: 1,
      max: 50_000,
      packId,
      field: `source "${id}" maxCommits`,
    }));
  }
  return source;
}

function defaultKind(type) {
  if (type === "git-history") return "commit";
  if (type === "csv") return "catalog";
  return "source";
}

function normalizeAnswerPolicy(raw, packId, sourceIds) {
  const policy = raw || {};
  if (typeof policy !== "object" || Array.isArray(policy)) {
    fail(packId, "answerPolicy must be an object");
  }
  const sourceOrder = stringList(policy.sourceOrder, packId, "answerPolicy.sourceOrder");
  for (const sourceId of sourceOrder) {
    if (!sourceIds.has(sourceId)) {
      fail(packId, `answerPolicy.sourceOrder names unknown source "${sourceId}"`);
    }
  }
  if (new Set(sourceOrder).size !== sourceOrder.length) {
    fail(packId, "answerPolicy.sourceOrder cannot contain duplicates");
  }
  return {
    sourceOrder,
    mentionSymbolOrigin: booleanValue(
      policy.mentionSymbolOrigin,
      false,
      packId,
      "answerPolicy.mentionSymbolOrigin",
    ),
    mentionDefaults: booleanValue(
      policy.mentionDefaults,
      false,
      packId,
      "answerPolicy.mentionDefaults",
    ),
  };
}

export function normalizeManifest(raw, { directory = "" } = {}) {
  if (!raw || typeof raw !== "object") throw new ManifestError("manifest must be a JSON object");
  const id = String(raw.id || "").trim();
  if (!ID_PATTERN.test(id)) throw new ManifestError(`pack id "${id}" must be kebab-case`);
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail(id, `schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.sources) || !raw.sources.length) {
    fail(id, "at least one source is required");
  }
  const version = String(raw.version || "").trim();
  if (!VERSION_PATTERN.test(version)) fail(id, "version must use semantic versioning");
  if (raw.instructionsFile !== undefined) {
    fail(id, "instructionsFile was removed; use the validated answerPolicy object");
  }

  const activation = raw.activation || {};
  const mode = String(activation.mode || "auto").trim();
  if (!ACTIVATION_MODES.has(mode)) {
    fail(id, `activation.mode must be one of ${[...ACTIVATION_MODES].join(", ")}`);
  }

  const retrieval = raw.retrieval || {};
  const seen = new Set();
  const sources = raw.sources.map((source) => normalizeSource(source, id, seen));

  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: String(raw.name || "").trim().slice(0, 80) || id,
    version,
    description: String(raw.description || "").trim().slice(0, 500),
    directory,
    activation: {
      mode,
      keywords: stringList(activation.keywords, id, "activation.keywords")
        .map((keyword) => keyword.toLowerCase()),
      symbols: stringList(activation.symbols, id, "activation.symbols")
        .map((symbol) => symbol.toLowerCase()),
      stopSymbols: stringList(activation.stopSymbols, id, "activation.stopSymbols")
        .map((symbol) => symbol.toLowerCase()),
    },
    retrieval: {
      maxResults: Math.floor(boundedNumber(retrieval.maxResults, {
        fallback: 8,
        min: 1,
        max: 40,
        packId: id,
        field: "retrieval.maxResults",
      })),
      maxCharacters: Math.floor(boundedNumber(retrieval.maxCharacters, {
        fallback: 12_000,
        min: 500,
        max: 60_000,
        packId: id,
        field: "retrieval.maxCharacters",
      })),
      maxPerDocument: Math.floor(boundedNumber(retrieval.maxPerDocument, {
        fallback: 2,
        min: 1,
        max: 10,
        packId: id,
        field: "retrieval.maxPerDocument",
      })),
      minScore: boundedNumber(retrieval.minScore, {
        fallback: 0.15,
        min: 0,
        max: 1,
        packId: id,
        field: "retrieval.minScore",
      }),
      exactSymbolsFirst: retrieval.exactSymbolsFirst !== false,
    },
    sources,
    answerPolicy: normalizeAnswerPolicy(raw.answerPolicy, id, seen),
    evaluationsFile: String(raw.evaluationsFile || "").trim(),
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveContainedPath(root, candidate, label = "path") {
  const rootPath = await realpath(path.resolve(root)).catch((error) => {
    throw new ManifestError(`${label} root is unavailable: ${error.message}`);
  });
  const lexicalPath = path.resolve(rootPath, candidate || ".");
  if (!isInside(rootPath, lexicalPath)) {
    throw new ManifestError(`${label} escapes its allowed root`);
  }
  const targetPath = await realpath(lexicalPath).catch((error) => {
    throw new ManifestError(`${label} is unavailable: ${error.message}`);
  });
  if (!isInside(rootPath, targetPath)) {
    throw new ManifestError(`${label} resolves outside its allowed root`);
  }
  return targetPath;
}

export function sourceMountEnvName(mount) {
  return `KNOWLEDGE_SOURCE_${String(mount).replaceAll("-", "_").toUpperCase()}`;
}

export async function resolveSourcePath(source, { manifest, env = process.env }) {
  let root = manifest.directory;
  if (source.mount) {
    const envName = sourceMountEnvName(source.mount);
    root = env[envName]?.trim();
    if (!root) {
      throw new ManifestError(
        `${manifest.id}: source "${source.id}" needs ${envName} to point at an allowed source root`,
      );
    }
  }
  return resolveContainedPath(root, source.path || ".", `${manifest.id}:${source.id}`);
}

export async function readPackFile(manifest, relativePath, field = "pack file") {
  if (!relativePath) throw new ManifestError(`${manifest.id}: ${field} is not configured`);
  const file = await resolveContainedPath(manifest.directory, relativePath, `${manifest.id}:${field}`);
  return readFile(file, "utf8");
}

export function manifestHash(manifest) {
  const { directory: _directory, evaluationsFile: _evaluationsFile, ...portable } = manifest;
  return createHash("sha256").update(JSON.stringify(portable)).digest("hex").slice(0, 24);
}

export async function loadManifest(packDirectory) {
  const directory = await realpath(path.resolve(packDirectory)).catch((error) => {
    throw new ManifestError(`Could not open pack directory ${packDirectory}: ${error.message}`);
  });
  const file = await resolveContainedPath(directory, "manifest.json", "manifest.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new ManifestError(`Could not read ${file}: ${error.message}`);
  }
  return normalizeManifest(parsed, { directory });
}

export async function listPackDirectories(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "manifest.json");
    const found = await stat(candidate).then((info) => info.isFile()).catch(() => false);
    if (found) directories.push(path.join(root, entry.name));
  }
  return directories.sort();
}
