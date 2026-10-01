import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { checkFiles } from "../scripts/check.js";

test("the syntax check fails when a later file has invalid JavaScript", async (t) => {
  const directory = await mkdtemp("/tmp/qssm-wiki-check-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.js"), second = path.join(directory, "second.js");
  await writeFile(first, "const okay = true;\n");
  await writeFile(second, "const invalid = ;\n");
  assert.equal(await checkFiles([first, second]), false);
  await writeFile(second, "const alsoOkay = true;\n");
  assert.equal(await checkFiles([first, second]), true);
});
