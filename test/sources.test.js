import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { collectSource } from "../src/knowledge/sources.js";

test("source indexing includes large menu files and reads the cited revision despite local edits", async (t) => {
  const root = await mkdtemp("/tmp/qssm-wiki-source-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  await mkdir(`${root}/Quake`);
  const committed = '// menu padding\n'.repeat(40000) + '\nvoid M_Reviewed(void) { /* original behavior */ }\n';
  await writeFile(`${root}/Quake/menu.c`, committed);
  git("add", "Quake/menu.c");
  git("-c", "user.name=Wiki Test", "-c", "user.email=wiki@example.invalid", "commit", "-qm", "Reviewed menu");
  const revision = git("rev-parse", "HEAD");
  await writeFile(`${root}/Quake/menu.c`, "void M_Changed(void) {}\n");
  git("-c", "user.name=Wiki Test", "-c", "user.email=wiki@example.invalid", "commit", "-qam", "Newer menu");
  await writeFile(`${root}/Quake/menu.c`, "void M_Uncommitted(void) {}\n");
  const found = await collectSource({ id: "engine", type: "git-worktree", path: "Quake", ref: revision,
    kind: "source", extractor: "c-source", include: ["*.c"], exclude: [],
    urlTemplate: "https://example.invalid/blob/{revision}/{path}#L{startLine}",
  }, { manifest: { id: "test", directory: root } });
  assert.equal(found.revision, revision);
  assert.equal(found.documents.length, 1);
  assert.ok(found.documents[0].chunks.some((chunk) => chunk.body.includes("M_Reviewed")));
  assert.ok(found.documents[0].chunks.every((chunk) => !/M_Changed|M_Uncommitted/.test(chunk.body)));
  assert.match(found.documents[0].url, new RegExp(`/blob/${revision}/Quake/menu.c`));
});
