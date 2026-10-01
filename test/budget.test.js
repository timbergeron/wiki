import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SpendLedger, reservationCost } from "../src/ask-budget.js";

async function fixture(t, limit = 1, now) {
  const directory = await mkdtemp("/tmp/qssm-wiki-budget-");
  const file = path.join(directory, "spend.sqlite");
  const ledgers = [];
  const open = () => { const ledger = new SpendLedger(file, { limit, now }); ledgers.push(ledger); return ledger; };
  t.after(async () => { for (const ledger of ledgers) ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { open };
}

test("reservations survive restarts and block concurrent processes at the daily ceiling", async (t) => {
  const { open } = await fixture(t);
  const first = open(), second = open();
  const request = first.reserve(0.75);
  assert.ok(request);
  assert.equal(second.reserve(0.75), null);
  assert.equal(open().reserve(0.3), null, "reopening the ledger cannot reset the budget");
  request.settle(0.1);
  assert.ok(second.reserve(0.75), "known actual usage refunds the unused reservation");
  request.settle(0);
  assert.equal(first.reserve(0.2), null, "a settlement cannot be replayed for a refund");
});

test("unknown costs remain reserved and UTC rollover doesn't refund today's budget", async (t) => {
  let date = new Date("2026-09-30T23:59:59Z");
  const { open } = await fixture(t, 1, () => date);
  const ledger = open();
  const yesterday = ledger.reserve(0.75);
  yesterday.settle(null);
  assert.equal(open().reserve(0.5), null);
  date = new Date("2026-10-01T00:00:01Z");
  assert.ok(ledger.reserve(0.75));
  yesterday.settle(0.1);
  assert.equal(ledger.reserve(0.5), null, "settle the original UTC day, not the current day");
});

test("zero budget disables paid requests and reservations cover prompt and output limits", async (t) => {
  const { open } = await fixture(t, 0);
  assert.equal(open().reserve(0), null);
  const prices = { prompt: 1, completion: 2 };
  assert.ok(reservationCost([{ content: "é".repeat(100) }], 4096, prices) > 4096 * 2 / 1_000_000);
});
