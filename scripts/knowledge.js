#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackIndex, indexPathFor } from "../src/knowledge/build.js";
import { sqliteAvailable, sqliteUnavailableReason } from "../src/knowledge/database.js";
import {
  listPackDirectories,
  loadManifest,
  readPackFile,
  sourceMountEnvName,
} from "../src/knowledge/manifest.js";
import { citationLabel } from "../src/knowledge/prompt.js";
import { PackIndex } from "../src/knowledge/retriever.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDirectory = path.join(root, "knowledge-packs");
const indexDirectory = path.join(root, "data", "knowledge");
process.env.KNOWLEDGE_SOURCE_QSSM ||= process.env.QSSM_DIR || path.join(root, "..", "QSS-M");

async function manifestsFor(packId) {
  const directories = await listPackDirectories(packsDirectory);
  const manifests = [];
  for (const directory of directories) {
    if (packId && path.basename(directory) !== packId) continue;
    manifests.push(await loadManifest(directory));
  }
  if (packId && !manifests.length) throw new Error(`No knowledge pack named "${packId}"`);
  return manifests;
}

function formatCount(value, noun) {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

async function commandList() {
  const manifests = await manifestsFor("");
  if (!manifests.length) {
    console.log(`No knowledge packs in ${path.relative(root, packsDirectory)}/`);
    return;
  }
  for (const manifest of manifests) {
    const indexPath = indexPathFor(indexDirectory, manifest.id);
    let status = "not built";
    try {
      const index = await PackIndex.open(manifest, indexPath);
      status = `built ${index.meta.built_at?.slice(0, 10) || "?"} (${index.meta.fingerprint})`;
      index.close();
    } catch (error) {
      status = error.code === "ENOENT" ? "not built" : `unusable: ${error.message}`;
    }
    console.log(`${manifest.id}  ${manifest.name} ${manifest.version}  [${status}]`);
    console.log(`  ${manifest.description}`);
    console.log(`  activation: ${manifest.activation.mode}, sources: ${
      manifest.sources.map((source) => `${source.id}:${source.type}`).join(", ")
    }`);
  }
}

async function commandValidate(packId) {
  const manifests = await manifestsFor(packId);
  for (const manifest of manifests) {
    console.log(`${manifest.id}: manifest is valid (${formatCount(manifest.sources.length, "source")})`);
    for (const source of manifest.sources) {
      const mountEnv = source.mount ? sourceMountEnvName(source.mount) : "";
      const location = mountEnv
        ? `${mountEnv} (${process.env[mountEnv] ? "set" : "unset"})${source.path === "." ? "" : `/${source.path}`}`
        : source.url || `pack:${source.path}`;
      console.log(`  ${source.id} (${source.type}, authority ${source.authority}) ${location}`);
    }
  }
}

async function commandBuild(packId) {
  if (!(await sqliteAvailable())) throw new Error(sqliteUnavailableReason());
  const manifests = await manifestsFor(packId);
  for (const manifest of manifests) {
    console.log(`Building ${manifest.id}...`);
    const stats = await buildPackIndex(manifest, { directory: indexDirectory });
    for (const source of stats.sources) {
      console.log(
        `  ${source.id.padEnd(10)} ${String(source.revision || "").padEnd(22)} ` +
        `${formatCount(source.documents, "document")}, ${formatCount(source.chunks, "chunk")}, ` +
        `${formatCount(source.symbols, "symbol")} in ${(source.milliseconds / 1000).toFixed(1)}s`,
      );
    }
    console.log(
      `  → ${path.relative(root, stats.path)} (${formatCount(stats.chunks, "chunk")}, ` +
      `fingerprint ${stats.fingerprint})`,
    );
  }
}

async function withIndex(manifest, handler) {
  const indexPath = indexPathFor(indexDirectory, manifest.id);
  let index;
  try {
    index = await PackIndex.open(manifest, indexPath);
  } catch (error) {
    throw new Error(
      `${manifest.id} has no usable index (${error.message}). Run: npm run index`,
    );
  }
  try {
    return await handler(index);
  } finally {
    index.close();
  }
}

function matchingResults(results, expect, defaultMaxRank = 3) {
  const maxRank = Math.max(1, Math.floor(Number(expect.maxRank) || defaultMaxRank));
  return results.slice(0, maxRank).filter((result) => {
    if (expect.exactLocator && result.locator !== expect.exactLocator) return false;
    if (expect.locator && !result.locator.includes(expect.locator)) return false;
    if (expect.kind && result.kind !== expect.kind) return false;
    if (expect.sourceId && result.sourceId !== expect.sourceId) return false;
    if (expect.symbol && !result.body.toLowerCase().includes(expect.symbol.toLowerCase())) {
      return false;
    }
    if (expect.text && !result.body.toLowerCase().includes(expect.text.toLowerCase())) {
      return false;
    }
    return true;
  });
}

function matchesExpectation(results, expect) {
  return matchingResults(results, expect).length > 0;
}

async function commandTest(packId) {
  const manifests = await manifestsFor(packId);
  let failures = 0;
  let total = 0;

  for (const manifest of manifests) {
    if (!manifest.evaluationsFile) {
      console.log(`${manifest.id}: no evaluations file`);
      continue;
    }
    const { questions, offTopic = [] } = JSON.parse(
      await readPackFile(manifest, manifest.evaluationsFile, "evaluationsFile"),
    );

    await withIndex(manifest, (index) => {
      console.log(`${manifest.id}: ${formatCount(questions.length, "question")}`);
      for (const item of questions) {
        total += 1;
        const activated = index.activatesFor(item.question);
        const results = activated ? index.retrieve(item.question) : [];
        const expectations = Array.isArray(item.expect) ? item.expect : [item.expect];
        const expected = expectations.every(
          (expectation) => matchesExpectation(results, expectation),
        );
        const forbidden = Array.isArray(item.forbid)
          ? item.forbid
          : item.forbid ? [item.forbid] : [];
        const clean = forbidden.every((rule) => matchingResults(results, rule).length === 0);
        const passed = activated && expected && clean;
        if (!passed) failures += 1;
        console.log(
          `  ${passed ? "pass" : "FAIL"}  ${item.question}` +
          (passed ? "" : `\n        activated=${activated} top=${
            results.slice(0, 3).map((result) => result.locator).join(", ") || "nothing"
          }`),
        );
      }

      for (const question of offTopic) {
        total += 1;
        const activated = index.activatesFor(question);
        if (activated) failures += 1;
        console.log(`  ${activated ? "FAIL" : "pass"}  [off topic] ${question}`);
      }
    });
  }

  console.log(`\n${total - failures}/${total} questions retrieved their expected evidence`);
  if (failures) process.exitCode = 1;
}

async function commandQuery(packId, question) {
  if (!packId || !question) throw new Error('Usage: knowledge query <packId> "question"');
  const [manifest] = await manifestsFor(packId);
  await withIndex(manifest, (index) => {
    console.log(`activation: ${index.activatesFor(question) ? "yes" : "no"}`);
    const results = index.retrieve(question);
    if (!results.length) {
      console.log("no evidence retrieved");
      return;
    }
    for (const result of results) {
      console.log(`\n[${result.score}] ${citationLabel(result)}  <- ${result.reasons.join(", ")}`);
      console.log(result.body.split("\n").slice(0, 6).map((line) => `    ${line}`).join("\n"));
    }
  });
}

const COMMANDS = {
  list: () => commandList(),
  validate: (args) => commandValidate(args[0] || ""),
  build: (args) => commandBuild(args[0] || ""),
  test: (args) => commandTest(args[0] || ""),
  query: (args) => commandQuery(args[0], args.slice(1).join(" ")),
};

const [command = "list", ...args] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command "${command}". Try: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(1);
}
handler(args).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
