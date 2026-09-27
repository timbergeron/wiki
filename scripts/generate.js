#!/usr/bin/env node
// Writes site/data/faq.json: one grounded answer per question in faq/questions.json.
//
// Each answer records a fingerprint of its question, prompt, model, and evidence. On the
// next run an answer is regenerated only when that fingerprint changes — i.e. when the
// code or sheet behind it changed — so a routine refresh costs little or nothing.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_RULES, answerMessages, openEvidence, unknownSymbols } from "../src/evidence.js";
import { OpenRouterClient } from "../src/openrouter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const faqPath = path.join(root, "site", "data", "faq.json");
const model = process.env.OPENROUTER_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const force = process.argv.includes("--force");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");
const budget = Number(process.env.GENERATE_BUDGET_USD || 1);

function fingerprint(question, sources) {
  return createHash("sha256")
    .update(JSON.stringify({ question, model, rules: ANSWER_RULES, evidence: sources.map((s) => s.text) }))
    .digest("hex")
    .slice(0, 16);
}

// Keep only the citations the answer actually uses, renumbered 1..n in reading order.
function compactCitations(markdown, sources) {
  const order = [];
  for (const [, number] of markdown.matchAll(/\[(\d+)\]/g)) {
    const id = Number(number);
    if (sources[id - 1] && !order.includes(id)) order.push(id);
  }
  const text = markdown
    .replace(/\[(\d+)\]/g, (match, number) => {
      const at = order.indexOf(Number(number));
      return at >= 0 ? `[${at + 1}]` : "";
    })
    .replace(/(\[\d+\])(\s*\1)+/g, "$1");
  const citations = order.map((id) => {
    const { label, kind, url } = sources[id - 1];
    return { label, kind, url };
  });
  return { text, citations };
}

async function main() {
  const questions = JSON.parse(await readFile(path.join(root, "faq", "questions.json"), "utf8"));
  let previous = { answers: [] };
  try {
    previous = JSON.parse(await readFile(faqPath, "utf8"));
  } catch {}
  const cached = new Map(previous.answers.map((answer) => [answer.id, answer]));

  const evidence = await openEvidence(root);
  const client = apiKey && new OpenRouterClient({
    model,
    maxOutputTokens: 4096,
    retryOutputTokens: 8192,
    requestTimeoutMs: 120_000,
    publicUrl: "https://github.com/timbergeron/wiki",
    logger: { info() {}, warn: console.warn, error: console.error },
  });

  let spent = 0;
  let generated = 0;
  let skipped = 0;
  const answers = [];
  for (const item of questions) {
    const sources = evidence.gather(item.question, { hints: item.hints || [] });
    const hash = fingerprint(item.question, sources);
    const old = cached.get(item.id);
    const wanted = !only || only.includes(item.id);
    if (old && (!wanted || (!force && old.hash === hash))) {
      answers.push({ ...old, section: item.section, question: item.question });
      continue;
    }
    if (!client || spent >= budget) {
      skipped += 1;
      if (old) answers.push({ ...old, section: item.section, question: item.question, stale: true });
      continue;
    }

    process.stdout.write(`  ${item.id.padEnd(12)} `);
    const messages = answerMessages(item.question, sources);
    let result = await client.complete({ apiKey, messages });
    let cost = result.cost;
    let invented = unknownSymbols(result.text, evidence.byName);
    if (invented.length) {
      // One repair pass: name the invented symbols and ask for a corrected answer.
      const repaired = await client.complete({
        apiKey,
        messages: [
          ...messages,
          { role: "assistant", content: result.text },
          {
            role: "user",
            content: `These names do not exist in QSS-M: ${invented.join(", ")}. Rewrite the answer without them, using only names that appear in the evidence. Return only the answer.`,
          },
        ],
      });
      cost += repaired.cost;
      result = repaired;
      invented = unknownSymbols(result.text, evidence.byName);
    }
    spent += cost;
    generated += 1;

    const { text, citations } = compactCitations(result.text, sources);
    const related = [...new Set(
      [...text.matchAll(/`([^`\n]+)`/g)]
        .map((match) => match[1].trim().split(/\s+/)[0])
        .filter((name) => evidence.byName.has(name.toLowerCase())),
    )];
    answers.push({
      id: item.id,
      section: item.section,
      question: item.question,
      answer: text,
      citations,
      related,
      ...(invented.length && { unverified: invented }),
      model: result.model,
      sha: evidence.reference.source.shortSha,
      hash,
      generatedAt: new Date().toISOString(),
    });
    console.log(`$${cost.toFixed(4)}${invented.length ? `  (unverified: ${invented.join(", ")})` : ""}`);
  }
  evidence.close();

  const faq = {
    model,
    source: evidence.reference.source,
    answers,
  };
  await writeFile(faqPath, `${JSON.stringify(faq, null, 1)}\n`);
  console.log(
    `FAQ: ${answers.length} answers, ${generated} regenerated for $${spent.toFixed(4)}` +
    (skipped ? `, ${skipped} skipped (${client ? "budget reached" : "no OPENROUTER_API_KEY"})` : ""),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
