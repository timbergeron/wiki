import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { openDatabase } from "./database.js";
import { manifestHash } from "./manifest.js";
import { collectSource } from "./sources.js";

export function indexPathFor(directory, packId) {
  return path.join(directory, `${packId}.sqlite`);
}

function fingerprint(manifestDigest, revisions, contentDigest) {
  return createHash("sha256")
    .update(JSON.stringify({ manifestDigest, revisions, contentDigest }))
    .digest("hex")
    .slice(0, 16);
}

function symbolText(symbols) {
  return [...new Set(symbols.map((symbol) => symbol.name))].join(" ");
}

export async function buildPackIndex(manifest, { directory, env = process.env, logger = console } = {}) {
  await mkdir(directory, { recursive: true });
  const finalPath = indexPathFor(directory, manifest.id);
  const stagingPath = `${finalPath}.${process.pid}-${randomUUID()}.building`;

  const database = await openDatabase(stagingPath, { create: true });
  const insertSource = database.prepare(
    "INSERT INTO sources (id, type, authority, revision, document_count) VALUES (?, ?, ?, ?, ?)",
  );
  const insertDocument = database.prepare(
    "INSERT INTO documents (source_id, kind, locator, title, url, revision) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertChunk = database.prepare(
    "INSERT INTO chunks (document_id, ordinal, start_line, end_line, heading, symbols, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSearch = database.prepare(
    "INSERT INTO chunk_search (rowid, heading, body, symbols) VALUES (?, ?, ?, ?)",
  );
  const insertSymbol = database.prepare(
    "INSERT INTO symbols (name, display, kind, chunk_id, weight) VALUES (?, ?, ?, ?, ?)",
  );

  const revisions = {};
  const stats = { sources: [], documents: 0, chunks: 0, symbols: 0 };
  const contentHash = createHash("sha256");
  const manifestDigest = manifestHash(manifest);
  let builtFingerprint = "";

  try {
    database.exec("BEGIN");
    for (const source of manifest.sources) {
      const started = Date.now();
      const { revision, documents } = await collectSource(source, { manifest, env, logger });
      revisions[source.id] = revision;

      let chunkCount = 0;
      let symbolCount = 0;
      for (const document of documents) {
        contentHash.update(`${source.id}\0${document.locator}\0${document.revision || revision || ""}\0`);
        const documentId = Number(insertDocument.run(
          source.id,
          document.kind,
          document.locator,
          document.title,
          document.url || "",
          document.revision || revision || "",
        ).lastInsertRowid);

        document.chunks.forEach((chunk, ordinal) => {
          contentHash.update(`${ordinal}\0${chunk.heading || ""}\0${chunk.body}\0`);
          const flattened = symbolText(chunk.symbols);
          const chunkId = Number(insertChunk.run(
            documentId,
            ordinal,
            chunk.startLine ?? null,
            chunk.endLine ?? null,
            chunk.heading || "",
            flattened,
            chunk.body,
          ).lastInsertRowid);
          insertSearch.run(chunkId, chunk.heading || "", chunk.body, flattened);
          chunkCount += 1;

          const seen = new Set();
          for (const symbol of chunk.symbols) {
            const key = `${symbol.kind}:${symbol.name.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            insertSymbol.run(
              symbol.name.toLowerCase(),
              symbol.detail ? `${symbol.name} (${symbol.detail})` : symbol.name,
              symbol.kind,
              chunkId,
              symbol.weight ?? 1,
            );
            symbolCount += 1;
          }
        });
      }

      insertSource.run(source.id, source.type, source.authority, revision || "", documents.length);
      stats.sources.push({
        id: source.id,
        type: source.type,
        revision,
        documents: documents.length,
        chunks: chunkCount,
        symbols: symbolCount,
        milliseconds: Date.now() - started,
      });
      stats.documents += documents.length;
      stats.chunks += chunkCount;
      stats.symbols += symbolCount;
    }

    if (!stats.chunks) throw new Error(`${manifest.id}: no content was indexed`);

    const contentDigest = contentHash.digest("hex");
    builtFingerprint = fingerprint(manifestDigest, revisions, contentDigest);

    database.prepare(
      "INSERT INTO pack (id, name, version, schema_version, manifest_hash, built_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      manifest.id,
      manifest.name,
      manifest.version,
      manifest.schemaVersion,
      manifestDigest,
      new Date().toISOString(),
      builtFingerprint,
    );
    database.exec("COMMIT");
    database.exec("PRAGMA optimize");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction was never opened.
    }
    database.close();
    await rm(stagingPath, { force: true });
    throw error;
  }

  database.close();
  try {
    await rename(stagingPath, finalPath);
  } catch (error) {
    await rm(stagingPath, { force: true });
    throw error;
  }
  return { ...stats, path: finalPath, fingerprint: builtFingerprint };
}
