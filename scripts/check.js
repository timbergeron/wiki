#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function checkFiles(files) {
  let failed = false;
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  return !failed;
}

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(file));
    else if (entry.name.endsWith(".js")) files.push(file);
  }
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = (await Promise.all(["src", "scripts", "site", "test"].map((directory) => javascriptFiles(path.join(root, directory))))).flat();
  const okay = await checkFiles(files);
  if (okay) console.log(`Checked ${files.length} JavaScript files.`);
  process.exitCode = okay ? 0 : 1;
}
