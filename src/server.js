// Serves the static guide and an optional live "Ask" endpoint that answers questions
// from the locally prepared reference and source index, streamed from OpenRouter.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerMessages, openEvidence } from "./evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(root, "site");
const referencePath = path.join(siteDir, "data", "reference.json");

const config = {
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: Number(process.env.PORT) || 3012,
  apiKey: process.env.OPENROUTER_API_KEY?.trim() || "",
  model: process.env.OPENROUTER_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
  publicUrl: process.env.PUBLIC_URL?.trim() || "http://localhost:3012",
  allowedOrigin: process.env.ALLOWED_ORIGIN?.trim() || "",
  trustProxy: process.env.TRUST_PROXY === "1",
  dailyBudget: Number(process.env.ASK_DAILY_BUDGET_USD) || 1,
  perIpLimit: Number(process.env.ASK_PER_IP_PER_10_MIN) || 8,
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

// Evidence is reopened whenever a refresh rewrites reference.json.
let evidence = null;
let evidenceMtime = 0;
async function currentEvidence() {
  const { mtimeMs } = await stat(referencePath);
  if (!evidence || mtimeMs !== evidenceMtime) {
    const next = await openEvidence(root);
    evidence?.close();
    evidence = next;
    evidenceMtime = mtimeMs;
  }
  return evidence;
}

const spend = { day: "", usd: 0 };
const recent = new Map();
function allow(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) Object.assign(spend, { day: today, usd: 0 });
  if (spend.usd >= config.dailyBudget) return "Live answers are resting until tomorrow. The FAQ and console reference still work.";
  const times = (recent.get(ip) || []).filter((time) => now - time < 600_000);
  if (times.length >= config.perIpLimit) return "You're asking faster than we can answer. Try again in a few minutes.";
  times.push(now);
  recent.set(ip, times);
  if (recent.size > 5000) recent.clear();
  return "";
}

function clientIp(request) {
  const forwarded = config.trustProxy && request.headers["x-forwarded-for"];
  return (forwarded ? String(forwarded).split(",")[0] : request.socket.remoteAddress || "").trim();
}

function cors(request, response) {
  if (config.allowedOrigin && request.headers.origin === config.allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", config.allowedOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 4096) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("too large");
  }
  return JSON.parse(body || "{}");
}

async function ask(request, response) {
  let question = "";
  try {
    question = String((await readBody(request)).question || "").replace(/\s+/g, " ").trim();
  } catch {
    return sendJson(response, 400, { error: "Send JSON with a question." });
  }
  if (question.length < 3 || question.length > 300) {
    return sendJson(response, 400, { error: "Questions should be between 3 and 300 characters." });
  }
  const ip = clientIp(request);
  const refusal = allow(ip);
  if (refusal) return sendJson(response, 429, { error: refusal });

  const found = await currentEvidence();
  const sources = found.gather(question);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("sources", sources.map(({ id, label, kind, url }) => ({ id, label, kind, url })));

  const abort = new AbortController();
  response.on("close", () => abort.abort());
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.publicUrl,
        "X-Title": "QSS-M Wiki",
      },
      body: JSON.stringify({
        model: config.model,
        messages: answerMessages(question, sources),
        stream: true,
        temperature: 0.3,
        max_completion_tokens: 4096,
        usage: { include: true },
        user: createHash("sha256").update(`web:${ip}`).digest("hex").slice(0, 32),
      }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
    });
    if (!upstream.ok || !upstream.body) throw new Error(`OpenRouter returned ${upstream.status}`);

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(parsed.error.message || "Provider error");
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) send("delta", text);
        if (parsed.usage?.cost) spend.usd += Number(parsed.usage.cost) || 0;
      }
    }
    send("done", {});
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error("Ask failed:", error.message);
      send("fail", { error: "The answer service hiccuped. Try again in a moment." });
    }
  }
  response.end();
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://local");
  let relative = decodeURIComponent(url.pathname);
  if (relative.endsWith("/")) relative += "index.html";
  const file = path.join(siteDir, path.normalize(relative));
  if (!file.startsWith(siteDir + path.sep)) return sendJson(response, 404, { error: "Not found" });
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return sendJson(response, 404, { error: "Not found" });
  }
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
  const headers = { "Cache-Control": "no-cache", "Last-Modified": modified, "X-Content-Type-Options": "nosniff" };
  if (request.headers["if-modified-since"] === modified) return response.writeHead(304, headers).end();
  response.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": info.size });
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    cors(request, response);
    const { pathname } = new URL(request.url, "http://local");
    if (pathname === "/api/ask" && config.allowedOrigin && request.headers.origin && request.headers.origin !== config.allowedOrigin) {
      return sendJson(response, 403, { error: "This origin cannot request live answers." });
    }
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    if (pathname === "/api/status") {
      return sendJson(response, 200, { ask: Boolean(config.apiKey), model: config.model });
    }
    if (pathname === "/api/ask" && request.method === "POST") {
      if (!config.apiKey) return sendJson(response, 503, { error: "Live answers are not configured." });
      return await ask(request, response);
    }
    if (request.method === "GET" || request.method === "HEAD") return await serveStatic(request, response);
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Something went wrong." });
    else response.end();
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `QSS-M Wiki on http://localhost:${config.port} ` +
    `(live answers ${config.apiKey ? `on, ${config.model}` : "off — set OPENROUTER_API_KEY"})`,
  );
});
