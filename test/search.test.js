import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { searchGuide } from "../site/search.js";

const reference = JSON.parse(await readFile(new URL("../site/data/reference.json", import.meta.url)));
const faq = JSON.parse(await readFile(new URL("../site/data/faq.json", import.meta.url)));
const search = (query) => searchGuide(query, { faq: faq.answers, entries: reference.entries });

test("natural questions rank the relevant FAQ above unrelated word matches", () => {
  assert.equal(search("turn off music").find((result) => result.type === "faq").item.id, "sound");
  assert.equal(search("mouse sensitivity").find((result) => result.type === "faq").item.id, "mouse");
  assert.equal(search("red crosshair").find((result) => result.type === "faq").item.id, "crosshair");
  assert.ok(!search("red crosshair").some((result) => result.item.name === "cl_nopred"));
});

test("exact identifiers, signed commands, and symbol prefixes retain priority", () => {
  for (const name of ["fov", "host_maxfps", "+attack", "-attack", "snd_filterquality"]) assert.equal(search(name)[0].item.name, name);
  assert.ok(search("crossh").some((result) => result.item.name === "crosshair"));
  assert.deepEqual(search("how do i"), []);
});
