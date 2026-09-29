import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { openEvidence } from "../src/evidence.js";

test("live crosshair answers receive locally reviewed guidance before community notes", async () => {
  const evidence = await openEvidence(path.resolve("."));
  try {
    const sources = evidence.gather("How do I change my crosshair to a green dot?");
    assert.equal(sources[0].kind, "faq");
    assert.match(sources[0].text, /Style 1 uses your chosen color too/);
    assert.match(sources[0].url, /#faq\/crosshair$/);
    assert.doesNotMatch(sources[0].text, /\[\d+\]/, "FAQ citations must not be confused with the live answer's source IDs");
    assert.ok(sources.some((s) => s.kind === "cvar" && s.label === "crosshair"));
  } finally {
    evidence.close();
  }
});
