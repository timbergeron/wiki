const SCHEMA = `
CREATE TABLE IF NOT EXISTS pack (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  authority REAL NOT NULL,
  revision TEXT NOT NULL DEFAULT '',
  document_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  heading TEXT NOT NULL DEFAULT '',
  symbols TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search
  USING fts5(heading, body, symbols, content='chunks', content_rowid='id');

CREATE TABLE IF NOT EXISTS symbols (
  name TEXT NOT NULL,
  display TEXT NOT NULL,
  kind TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
`;

let sqliteModule;
let sqliteError = "";

async function loadSqlite() {
  if (sqliteModule || sqliteError) return sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
  } catch (error) {
    sqliteError = error.message;
  }
  return sqliteModule;
}

export async function sqliteAvailable() {
  return Boolean(await loadSqlite());
}

export function sqliteUnavailableReason() {
  return sqliteError
    ? `node:sqlite is unavailable (${sqliteError}). Knowledge packs need Node 22.13 or newer.`
    : "";
}

export async function openDatabase(filePath, { create = false } = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite) throw new Error(sqliteUnavailableReason());
  const database = new sqlite.DatabaseSync(filePath, {
    readOnly: !create,
  });
  if (create) database.exec(SCHEMA);
  return database;
}

export { SCHEMA };
