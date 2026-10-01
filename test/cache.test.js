import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EvidenceCache } from "../src/evidence-cache.js";

test("FAQ edits, index replacement/arrival, and manifest changes reload evidence without a restart", async (t) => {
  const root = await mkdtemp("/tmp/qssm-wiki-cache-");
  let loads = 0, closes = 0;
  const cache = new EvidenceCache(root, { open: async () => {
    loads++;
    const faq = await readFile(path.join(root, "site/data/faq.json"), "utf8");
    return { faq, close() { closes++; } };
  } });
  t.after(async () => { cache.close(); await rm(root, { recursive: true, force: true }); });
  for (const directory of ["site/data", "data/knowledge", "knowledge-packs/qssm"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "site/data/reference.json"), "reference");
  await writeFile(path.join(root, "site/data/faq.json"), "old faq");
  const [first, parallel] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(first, parallel);
  assert.equal(loads, 1);
  await writeFile(path.join(root, "site/data/faq.json.new"), "new faq");
  await rename(path.join(root, "site/data/faq.json.new"), path.join(root, "site/data/faq.json"));
  assert.equal((await cache.get()).faq, "new faq");
  assert.equal(loads, 2);
  await writeFile(path.join(root, "data/knowledge/qssm.sqlite"), "first index");
  await cache.get();
  await writeFile(path.join(root, "data/knowledge/replacement.sqlite"), "second index");
  await rename(path.join(root, "data/knowledge/replacement.sqlite"), path.join(root, "data/knowledge/qssm.sqlite"));
  await cache.get();
  await writeFile(path.join(root, "knowledge-packs/qssm/manifest.json"), "new manifest");
  await cache.get();
  assert.equal(loads, 5);
  assert.equal(closes, 4);
});

test("a failed reload retains the previous evidence and retries the changed bundle", async (t) => {
  const root = await mkdtemp("/tmp/qssm-wiki-cache-failure-");
  await mkdir(path.join(root, "site/data"), { recursive: true });
  let fail = false, closed = false;
  const previous = { close() { closed = true; } };
  const cache = new EvidenceCache(root, { open: async () => { if (fail) throw new Error("Invalid bundle"); return previous; } });
  t.after(async () => { cache.close(); await rm(root, { recursive: true, force: true }); });
  await cache.get();
  await writeFile(path.join(root, "site/data/faq.json"), "changed");
  fail = true;
  await assert.rejects(cache.get(), /Invalid bundle/);
  assert.equal(closed, false);
  fail = false;
  assert.equal(await cache.get(), previous);
});
