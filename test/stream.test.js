import assert from "node:assert/strict";
import { test } from "node:test";
import { readCompletion } from "../src/ask-stream.js";
import { readAnswerStream } from "../site/stream.js";

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
async function* bytes(text) { for (const byte of Buffer.from(text)) yield Uint8Array.of(byte); }
const delta = frame({ choices: [{ delta: { content: "Green café [1]." }, finish_reason: null }] });
const terminal = (reason) => frame({ choices: [{ delta: {}, finish_reason: reason }], usage: { cost: 0.001 } });

test("upstream framing survives UTF-8 chunks, CRLF, keepalives, and repeated terminal reasons", async () => {
  const deltas = [], costs = [];
  const stream = ": keepalive\n\n" + delta + terminal("stop") + "data: [DONE]\n\n";
  await readCompletion(bytes(stream.replaceAll("\n", "\r\n")), { onDelta: (text) => deltas.push(text), onCost: (cost) => costs.push(cost) });
  assert.equal(deltas.join(""), "Green café [1].");
  assert.deepEqual(costs, [0.001]);
});

test("token limits, EOF, filtered and empty responses cannot count as completed answers", async () => {
  for (const stream of [delta, delta + terminal("stop"), delta + terminal("length") + "data: [DONE]\n\n", terminal("stop") + "data: [DONE]\n\n", delta + terminal("content_filter") + "data: [DONE]\n\n"]) {
    await assert.rejects(readCompletion(bytes(stream), { onDelta() {}, onCost() {} }), /answer|limit/);
  }
});

test("provider errors retain reported cost and fail the answer", async () => {
  let cost = null;
  await assert.rejects(readCompletion(bytes(frame({ usage: { cost: 0.002 }, error: { message: "Provider stopped" } })), { onDelta() {}, onCost(value) { cost = value; } }), /Provider stopped/);
  assert.equal(cost, 0.002);
});

test("the browser requires the server's done event before accepting a partial answer", async () => {
  const partial = 'event: delta\ndata: "Half an answer"\n\n';
  await assert.rejects(readAnswerStream(bytes(partial)), /interrupted/);
  await assert.rejects(readAnswerStream(bytes(partial + 'event: fail\ndata: {"error":"Try again"}\n\n')), /Try again/);
  const complete = await readAnswerStream(bytes(partial + 'event: done\ndata: {}\n\n'));
  assert.equal(complete.text, "Half an answer");
});
