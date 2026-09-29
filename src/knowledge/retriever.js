import { openDatabase } from "./database.js";
import { manifestHash, SCHEMA_VERSION } from "./manifest.js";

const TOKEN_PATTERN = /[+-]?[A-Za-z_][A-Za-z0-9_.+-]*/g;
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "does", "did", "how", "why", "when", "where",
  "which", "that", "this", "there", "then", "than", "from", "into", "about", "your",
  "you", "are", "was", "were", "can", "could", "should", "would", "will", "have",
  "has", "had", "not", "but", "its", "it's", "any", "all", "out", "get", "got",
  "use", "used", "using", "make", "makes", "made", "work", "works", "who", "whom",
  "please", "thanks", "help", "question", "explain", "tell", "know", "think",
]);
const MAX_TOKENS = 24;
const FTS_LIMIT = 120;
const KIND_LIMIT = 10;
const COMMON_TERM_RATIO = 0.1;
// "when did", "what changed", "why does" are answered by history, not by current code.
// "where is", "which file", "how is it implemented" are answered by code, not by a catalog row.
const LOCATION_INTENT = /\b(where|which file|what file|located|location|implement\w*|defined|handles?|handled|source file)\b/i;
const LOCATION_WORDS = new Set(["source", "file", "implements", "implement", "implemented", "implementation", "located", "location", "defined"]);
const HISTORY_INTENT = /\b(when|why|changed?|changes|recent|recently|history|commits?|touched?|regress\w*|introduced|added|removed|broke|broken|since)\b/i;

export function questionTokens(question) {
  const tokens = [];
  const seen = new Set();
  for (const match of String(question).matchAll(TOKEN_PATTERN)) {
    const raw = match[0].replace(/[.+-]+$/, "");
    if (raw.length < 3) continue;
    const lower = raw.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    tokens.push({
      raw,
      lower,
      identifierLike: /[_.]/.test(lower) || /^[+-]/.test(match[0]),
    });
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

function ftsQuery(tokens) {
  const terms = tokens.map((token) => `"${token.lower.replaceAll('"', '""')}"`);
  return terms.length ? terms.join(" OR ") : "";
}

function keywordMatches(question, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, "i").test(question);
}

function validateIndexMetadata(manifest, meta) {
  const expectedHash = manifestHash(manifest);
  if (
    meta.id !== manifest.id ||
    meta.version !== manifest.version ||
    meta.schema_version !== SCHEMA_VERSION ||
    meta.manifest_hash !== expectedHash
  ) {
    throw new Error(
      `${manifest.id}: index does not match manifest ${manifest.version}; rebuild it with ` +
      `"npm run index"`,
    );
  }
}

export class PackIndex {
  constructor({ manifest, database, meta }) {
    this.manifest = manifest;
    this.database = database;
    this.meta = meta;
    this.authority = new Map(
      database.prepare("SELECT id, authority FROM sources").all()
        .map((row) => [row.id, row.authority]),
    );
    this.symbolStatement = database.prepare(`
      SELECT s.name, s.display, s.kind, s.weight, c.id AS chunk_id
      FROM symbols s JOIN chunks c ON c.id = s.chunk_id
      WHERE s.name = ?
      ORDER BY s.weight DESC
      LIMIT 12
    `);
    this.searchStatement = database.prepare(`
      SELECT c.id AS chunk_id, bm25(chunk_search, 6.0, 1.0, 3.5) AS rank
      FROM chunk_search
      JOIN chunks c ON c.id = chunk_search.rowid
      WHERE chunk_search MATCH ?
      ORDER BY rank
      LIMIT ${FTS_LIMIT}
    `);
    this.kindSearchStatement = database.prepare(`
      SELECT c.id AS chunk_id, bm25(chunk_search, 6.0, 1.0, 3.5) AS rank
      FROM chunk_search
      JOIN chunks c ON c.id = chunk_search.rowid
      JOIN documents d ON d.id = c.document_id
      WHERE chunk_search MATCH ? AND d.kind = ?
      ORDER BY rank
      LIMIT ${KIND_LIMIT}
    `);
    this.chunkStatement = database.prepare(`
      SELECT c.id, c.heading, c.body, c.start_line, c.end_line, c.symbols,
             d.locator, d.title, d.url, d.kind, d.revision, d.source_id, d.id AS document_id
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ?
    `);
    this.knownSymbolStatement = database.prepare(
      "SELECT kind FROM symbols WHERE name = ? LIMIT 1",
    );
    this.termCountStatement = database.prepare(
      "SELECT count(*) AS matches FROM chunk_search WHERE chunk_search MATCH ?",
    );
    this.totalChunks = database.prepare("SELECT count(*) AS total FROM chunks").get().total || 1;
    this.termFrequency = new Map();
  }

  // A pack's own boilerplate — "QSS-M" in every catalog row, "quake" in every header —
  // matches thousands of chunks and drowns out the terms that actually locate an answer.
  isCommonTerm(token) {
    if (this.termFrequency.has(token.lower)) return this.termFrequency.get(token.lower);
    let common = false;
    try {
      const { matches } = this.termCountStatement.get(`"${token.lower.replaceAll('"', '""')}"`);
      common = matches / this.totalChunks > COMMON_TERM_RATIO;
    } catch {
      common = false;
    }
    this.termFrequency.set(token.lower, common);
    return common;
  }

  selectiveTokens(tokens) {
    const selective = tokens.filter((token) => !this.isCommonTerm(token));
    return selective.length ? selective : tokens;
  }

  static async open(manifest, indexPath) {
    const database = await openDatabase(indexPath, { create: false });
    try {
      const meta = database.prepare("SELECT * FROM pack LIMIT 1").get() || {};
      validateIndexMetadata(manifest, meta);
      return new PackIndex({ manifest, database, meta });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close() {
    try {
      this.database.close();
    } catch {
      // Already closed.
    }
  }

  symbolKind(name) {
    return this.knownSymbolStatement.get(String(name).toLowerCase())?.kind || "";
  }

  hasSymbol(name) {
    return Boolean(this.symbolKind(name));
  }

  activatesFor(question) {
    if (this.manifest.activation.mode === "always") return true;
    const text = String(question);
    if (this.manifest.activation.keywords.some((keyword) => keywordMatches(text, keyword))) {
      return true;
    }
    const stopSymbols = this.manifest.activation.stopSymbols;
    const activationSymbols = this.manifest.activation.symbols;
    return questionTokens(question).some((token) => {
      if (stopSymbols.includes(token.lower)) return false;
      if (!this.hasSymbol(token.lower)) return false;
      return token.identifierLike || activationSymbols.includes(token.lower);
    });
  }

  collectCandidates(tokens, preferKind) {
    const candidates = new Map();
    const add = (chunkId, score, reason) => {
      const existing = candidates.get(chunkId);
      if (existing) {
        existing.score = Math.max(existing.score, score);
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
        return;
      }
      candidates.set(chunkId, { chunkId, score, reasons: [reason] });
    };

    if (this.manifest.retrieval.exactSymbolsFirst) {
      for (const token of tokens) {
        for (const row of this.symbolStatement.all(token.lower)) {
          const precision = token.identifierLike ? 1 : 0.7;
          add(row.chunk_id, (0.7 + 0.3 * row.weight) * precision, `${row.kind} ${row.name}`);
        }
      }
    }

    const query = ftsQuery(this.selectiveTokens(tokens));
    if (query) {
      let rows = [];
      try {
        rows = this.searchStatement.all(query);
      } catch {
        rows = [];
      }
      rows.forEach((row, position) => {
        add(row.chunk_id, 0.62 * (1 - position / (FTS_LIMIT * 1.6)), "text match");
      });

      // A question about history competes with thousands of source chunks on the same
      // words, so give the preferred kind its own pool rather than a global thumb on
      // the scale that would distort every other question.
      if (preferKind) {
        let scoped = [];
        try {
          const identifierTokens = tokens.filter((token) => token.identifierLike);
          const scopedQuery = ftsQuery(
            identifierTokens.length ? identifierTokens : this.selectiveTokens(tokens),
          );
          scoped = this.kindSearchStatement.all(scopedQuery, preferKind);
        } catch {
          scoped = [];
        }
        scoped.forEach((row, position) => {
          add(row.chunk_id, 1 - position / (KIND_LIMIT * 2), `${preferKind} match`);
        });
      }
    }
    return [...candidates.values()];
  }

  retrieve(question) {
    let tokens = questionTokens(question);
    if (!tokens.length) return [];
    const locationIntent = LOCATION_INTENT.test(question);
    const historyIntent = HISTORY_INTENT.test(question);

    // "Which source file implements ..." describes the requested answer, not its
    // topic. Otherwise source/file matches can bury the relevant subsystem.
    if (locationIntent) {
      const topic = tokens.filter((token) => !LOCATION_WORDS.has(token.lower));
      if (topic.length) tokens = topic;
    }

    const resolved = this.collectCandidates(tokens, historyIntent ? "commit" : "")
      .map((candidate) => {
        const chunk = this.chunkStatement.get(candidate.chunkId);
        return chunk ? { ...candidate, chunk } : null;
      })
      .filter(Boolean);

    // A document with several matching chunks is usually the one the question is about,
    // which single-chunk bm25 scoring cannot see on its own.
    const documentHits = new Map();
    for (const item of resolved) {
      documentHits.set(item.chunk.document_id, (documentHits.get(item.chunk.document_id) || 0) + 1);
    }

    const scored = resolved
      .map((item) => {
        const authority = this.authority.get(item.chunk.source_id) ?? 0.5;
        const hits = documentHits.get(item.chunk.document_id) || 1;
        const spread = 1 + 0.1 * Math.min(3, Math.log2(hits));
        const named = tokens.some(
          (token) => token.lower.length > 3 && item.chunk.locator.toLowerCase().includes(token.lower),
        );
        const located = locationIntent && item.chunk.kind === "source" ? 1.35 : 1;
        const exact = item.reasons.some((reason) => !reason.endsWith("match")) ? 1.35 : 1;
        const historical = historyIntent
          ? item.chunk.kind === "commit"
            ? exact > 1 ? 3 : 2
            : 0.75
          : 1;
        return {
          ...item,
          score: item.score * authority * spread * located * exact * historical * (named ? 1.2 : 1),
        };
      })
      .sort((left, right) => right.score - left.score);

    const { maxResults, maxCharacters, maxPerDocument, minScore } = this.manifest.retrieval;
    const perDocument = new Map();
    const results = [];
    let characters = 0;

    for (const item of scored) {
      if (results.length >= maxResults) break;
      if (item.score < minScore) break;
      const used = perDocument.get(item.chunk.document_id) || 0;
      if (used >= maxPerDocument) continue;
      if (characters + item.chunk.body.length > maxCharacters && results.length) continue;

      perDocument.set(item.chunk.document_id, used + 1);
      characters += item.chunk.body.length;
      results.push({
        packId: this.manifest.id,
        score: Number(item.score.toFixed(4)),
        reasons: item.reasons,
        kind: item.chunk.kind,
        sourceId: item.chunk.source_id,
        locator: item.chunk.locator,
        title: item.chunk.title,
        heading: item.chunk.heading,
        url: item.chunk.url,
        revision: item.chunk.revision,
        startLine: item.chunk.start_line,
        endLine: item.chunk.end_line,
        body: item.chunk.body,
      });
    }
    return results;
  }
}
