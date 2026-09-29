import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let child;
let base;
const origin = "https://qssm.quakeone.com";

before(async () => {
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const { port } = portProbe.address();
  await new Promise((resolve) => portProbe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OPENROUTER_API_KEY: "", ALLOWED_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on("data", () => { clearTimeout(timeout); resolve(); });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

test("the published wiki can preflight JSON Ask requests", async () => {
  const response = await fetch(`${base}/api/ask`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.match(response.headers.get("access-control-allow-methods") || "", /\bPOST\b/);
  assert.match(response.headers.get("access-control-allow-headers") || "", /content-type/i);
});

test("other websites cannot initiate paid Ask requests", async () => {
  const response = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { Origin: "https://unrelated.example", "Content-Type": "application/json" },
    body: JSON.stringify({ question: "How do I change my crosshair?" }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("a missing key reports Ask unavailable while the guide remains accessible", async () => {
  const response = await fetch(`${base}/api/status`, { headers: { Origin: origin } });
  assert.equal((await response.json()).ask, false);
  assert.equal((await fetch(base)).status, 200);
  const ask = await fetch(`${base}/api/ask`, { method: "POST", headers: { Origin: origin } });
  assert.equal(ask.status, 503);
});
