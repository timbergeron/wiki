import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createQuestionClassifier } from "../src/question-scope.js";
import { openEvidence } from "../src/evidence.js";
import { createWikiServer } from "../src/server.js";

const reference = JSON.parse(await readFile(new URL("../site/data/reference.json", import.meta.url)));
const faq = JSON.parse(await readFile(new URL("../site/data/faq.json", import.meta.url)));
const evaluations = JSON.parse(await readFile(new URL("../knowledge-packs/qssm/evaluations.json", import.meta.url)));
const acceptsQuestion = createQuestionClassifier({ entries: reference.entries, faq: faq.answers });
const unrelated = [...evaluations.offTopic,
  "Can you write a Python script to rename files?",
  "Tell me a joke", "What is the weather tomorrow?", "How do I change my name on Facebook?",
  "What is the status of my order?", "How do I record my screen?",
  "How do I change my crosshair in Valorant?", "How do I install Minecraft mods?",
  "How do I change the FOV in Quake 3?", "What is the capital of France in QSS-M?",
  "Write a poem about QSS-M", "QSS-M: what is the stock price?",
  "QSS-M: explain general relativity", "QSS-M: tell me a joke",
];
const ordinary = [
  "How do I change my crosshair?", "turn off music", "mouse sensitivity", "invert my mouse",
  "How do I join a server?", "How do I host my own server?", "Where are screenshots saved?",
  "How do I install a mod?", "How do I reset everything to the defaults?",
  "How can I use a controller?", "How do I increase my FPS?", "What causes packet loss?",
  "How do I change my player name?", "What does the record command do?", "record",
  "What does HOST_MAXFPS do?", "How do I bind +attack?", "What does -basedir do?",
  "Why does the game stutter?", "Why does the game crash?",
  "What is QSS-M?", "How do I install QSS-M?", "Is QSS-M free?",
];

test("scope accepts every reviewed FAQ, retrieval evaluation, and ordinary player question without needing the index", () => {
  for (const question of [...faq.answers.map((answer) => answer.question), ...evaluations.questions.map((item) => item.question), ...ordinary]) {
    assert.equal(acceptsQuestion(question), true, question);
  }
});

test("unrelated questions cannot pass through incidental command words or appended engine names", () => {
  for (const question of unrelated) assert.equal(acceptsQuestion(question), false, question);
});

test("live evidence exposes the scope check and recognizes indexed source identifiers", async () => {
  const evidence = await openEvidence(path.resolve("."));
  try {
    assert.equal(evidence.acceptsQuestion("Where is Cbuf_AddText implemented?"), true);
    for (const question of unrelated) assert.equal(evidence.acceptsQuestion(question), false, question);
  } finally { evidence.close(); }
});

test("HTTP scope rejections never retrieve passages, create spending, consume paid quota, or call OpenRouter", async (t) => {
  const root = await mkdtemp("/tmp/qssm-wiki-scope-");
  let retrieved = 0, upstreamCalls = 0;
  const server = createWikiServer({ root,
    env: { OPENROUTER_API_KEY: "mock-key", ASK_PER_IP_PER_10_MIN: "1" },
    openEvidence: async () => ({ acceptsQuestion, gather() { retrieved++; return []; }, close() {} }),
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('data: {"choices":[{"delta":{"content":"Use fov 110."},"finish_reason":"stop"}],"usage":{"cost":0}}\n\ndata: [DONE]\n\n');
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const post = (question) => fetch(`http://127.0.0.1:${server.address().port}/api/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }),
  });
  for (const question of unrelated) {
    const response = await post(question);
    assert.equal(response.status, 422, question);
    assert.equal((await response.json()).code, "off_topic");
  }
  assert.equal(retrieved, 0);
  assert.equal(upstreamCalls, 0);
  await assert.rejects(stat(path.join(root, "data/ask-spend.sqlite")), { code: "ENOENT" });
  const answer = await post("How do I change my crosshair?");
  assert.equal(answer.status, 200, "rejections must leave the paid quota available");
  assert.match(await answer.text(), /event: done/);
  assert.equal(retrieved, 1);
  assert.equal(upstreamCalls, 1);
  assert.equal((await post("How do I change my crosshair?")).status, 429);
  assert.equal(upstreamCalls, 1);
});
