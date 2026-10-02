import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createWikiServer } from "../src/server.js";
import { answerMessages } from "../src/evidence.js";
import { reservationCost } from "../src/ask-budget.js";

const question = "What is fov?";
const cost = Math.ceil(reservationCost(answerMessages(question, []), 4096, { prompt: 1, completion: 2 }) * 1_000_000) / 1_000_000;
const stream = (reason = "stop", terminal = true) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Use fov 110." }, finish_reason: null }] })}\n\n` + (terminal ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { cost: 0.001 } })}\n\ndata: [DONE]\n\n` : ""));
const post = (base) => fetch(`${base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });

async function fixture(t, options = {}) {
  const root = await mkdtemp("/tmp/qssm-wiki-ask-");
  const servers = [];
  const open = async (fetchImpl, env = {}) => {
    const server = createWikiServer({ root, env: { OPENROUTER_API_KEY: "fake-key", ASK_DAILY_BUDGET_USD: String(options.limit ?? 1), ...env }, fetchImpl, openEvidence: async () => ({ acceptsQuestion: () => true, gather: () => [], close() {} }) });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  };
  t.after(async () => {
    for (const server of servers) if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  return { open };
}

test("paid Ask reserves before starting, enforces routing prices, and keeps spending across server restarts", async (t) => {
  const { open } = await fixture(t, { limit: cost });
  let start, finish;
  const started = new Promise((resolve) => { start = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  let upstreamCalls = 0;
  const first = await open(async (url, options) => {
    upstreamCalls++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.provider.max_price, { prompt: 1, completion: 2, request: 0 });
    start();
    await released;
    return stream();
  });
  const pending = post(first.base);
  await started;
  assert.equal((await post(first.base)).status, 429);
  assert.equal(upstreamCalls, 1);
  finish();
  const result = await pending;
  assert.match(await result.text(), /event: done/);
  await first.close();
  const restarted = await open(async () => { upstreamCalls++; return stream(); });
  assert.equal((await post(restarted.base)).status, 429);
  assert.equal(upstreamCalls, 1);
});

test("token-limited and disconnected upstream streams report fail rather than done", async (t) => {
  const { open } = await fixture(t);
  for (const options of [["length", true], ["stop", false]]) {
    const server = await open(async () => stream(...options));
    const answer = await (await post(server.base)).text();
    assert.match(answer, /event: fail/);
    assert.doesNotMatch(answer, /event: done/);
    await server.close();
  }
});

test("a zero daily budget prevents any upstream request", async (t) => {
  const { open } = await fixture(t, { limit: 0 });
  const server = await open(async () => assert.fail("a disabled budget must not call OpenRouter"));
  assert.equal((await post(server.base)).status, 429);
});
