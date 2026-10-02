import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { createWikiServer } from "../src/server.js";

async function fixture(t) {
  const root = await mkdtemp("/tmp/qssm-wiki-http-");
  await mkdir(`${root}/site`);
  await writeFile(`${root}/site/index.html`, "first");
  const questions = [];
  const server = createWikiServer({ root, env: { OPENROUTER_API_KEY: "mock", ALLOWED_ORIGIN: "https://qssm.quakeone.com" },
    openEvidence: async () => ({ acceptsQuestion: () => true, gather(question) { questions.push(question); return []; }, close() {} }),
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"Test answer."},"finish_reason":"stop"}],"usage":{"cost":0}}\n\ndata: [DONE]\n\n'),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, questions, base: `http://127.0.0.1:${server.address().port}` };
}

test("invalid URL encodings and NUL bytes are client errors and leave the server usable", async (t) => {
  const { base } = await fixture(t);
  for (const path of ["/%ZZ", "/%00"]) assert.equal((await fetch(base + path)).status, 400);
  assert.equal((await fetch(base)).status, 200);
});

test("cache validators detect same-second edits, respect ETag precedence, and vary by origin", async (t) => {
  const { base, root } = await fixture(t);
  const stamp = Math.floor(Date.now() / 1000);
  await utimes(`${root}/site/index.html`, stamp, stamp + 0.1);
  const first = await fetch(base);
  const tag = first.headers.get("etag");
  const modified = first.headers.get("last-modified");
  assert.ok(tag);
  assert.equal(first.headers.get("vary"), "Origin");
  assert.equal((await fetch(base, { headers: { "If-None-Match": tag } })).status, 304);
  await writeFile(`${root}/site/index.html`, "other");
  await utimes(`${root}/site/index.html`, stamp, stamp + 0.2);
  const updated = await fetch(base, { headers: { "If-None-Match": tag, "If-Modified-Since": modified } });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get("last-modified"), modified);
  assert.notEqual(updated.headers.get("etag"), tag);
  assert.equal(await updated.text(), "other");
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "5");
  assert.equal(await head.text(), "");
});

test("Ask rejects non-string questions and oversized byte bodies before fetching evidence", async (t) => {
  const { base, questions } = await fixture(t);
  for (const body of ['null', '{"question":123}', '{"question":["fov"]}', JSON.stringify({ question: "é".repeat(2200) })]) {
    const response = await fetch(`${base}/api/ask`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(questions, []);
});

test("Ask preserves Unicode split across request chunks", async (t) => {
  const { base, questions } = await fixture(t);
  const body = Buffer.from(JSON.stringify({ question: "How does café work?" }));
  const split = body.indexOf(Buffer.from("é")) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(result.status, 200);
  assert.match(result.text, /event: done/);
  assert.deepEqual(questions, ["How does café work?"]);
});
