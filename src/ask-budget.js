import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function reservationCost(messages, maxTokens, prices) {
  // Text-only prompts: one token per UTF-8 byte is a deliberately conservative
  // bound, with room for chat framing. Enforce the same prices on provider routing.
  const promptBound = Buffer.byteLength(JSON.stringify(messages)) + 1024;
  return (promptBound * prices.prompt + maxTokens * prices.completion) / 1_000_000;
}

export class SpendLedger {
  constructor(file, { limit, now = () => new Date() }) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, micro_usd INTEGER NOT NULL)");
    this.limit = Math.floor(limit * 1_000_000);
    this.now = now;
  }

  reserve(amount) {
    const day = this.now().toISOString().slice(0, 10);
    const units = Math.ceil(amount * 1_000_000);
    if (!Number.isSafeInteger(units) || units < 0) throw new Error("Invalid budget reservation");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT OR IGNORE INTO spend VALUES (?, 0)").run(day);
      const { micro_usd: spent } = this.database.prepare("SELECT micro_usd FROM spend WHERE day = ?").get(day);
      if (spent + units > this.limit || this.limit === 0) { this.database.exec("ROLLBACK"); return null; }
      this.database.prepare("UPDATE spend SET micro_usd = micro_usd + ? WHERE day = ?").run(units, day);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    let settled = false;
    return {
      settle: (cost) => {
        if (settled) return;
        // A disconnect/crash can hide the usage frame. Keep the full reservation.
        if (cost === null || !Number.isFinite(cost) || cost < 0) return;
        const actual = Math.ceil(cost * 1_000_000);
        this.database.prepare("UPDATE spend SET micro_usd = micro_usd + ? WHERE day = ?").run(actual - units, day);
        settled = true;
      },
    };
  }

  close() { this.database.close(); }
}
