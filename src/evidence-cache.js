import { stat } from "node:fs/promises";
import path from "node:path";
import { openEvidence } from "./evidence.js";

export class EvidenceCache {
  constructor(root, { open = openEvidence } = {}) {
    this.root = root;
    this.open = open;
    this.files = ["site/data/reference.json", "site/data/faq.json", "data/knowledge/qssm.sqlite", "knowledge-packs/qssm/manifest.json"].map((file) => path.join(root, file));
    this.evidence = null;
    this.signature = "";
    this.loading = null;
  }

  async get() {
    const signature = (await Promise.all(this.files.map(async (file) => {
      try {
        const info = await stat(file, { bigint: true });
        return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
    }))).join("|");
    if (this.loading) { await this.loading; return this.get(); }
    if (this.evidence && signature === this.signature) return this.evidence;
    this.loading = (async () => {
      const next = await this.open(this.root);
      this.evidence?.close();
      this.evidence = next;
      this.signature = signature;
      return next;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  close() { this.evidence?.close(); this.evidence = null; }
}
