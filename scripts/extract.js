#!/usr/bin/env node
// Builds site/data/reference.json from a QSS-M checkout: every console variable,
// console command, and command-line option the engine actually registers, merged
// with the human-written descriptions from the public commands-and-variables sheet.
// The source code is the authority for what exists and its default; the sheet only
// supplies prose.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { csvToRecords } from "../src/knowledge/csv.js";
import { scanCvars, stripComments } from "../src/reference-source.js";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qssm = path.resolve(process.env.QSSM_DIR || path.join(root, "..", "QSS-M"));
const output = path.join(root, "site", "data");
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1ubOuromaXpZonfL-eJ-KA7q-xSRiBBuSvxahzF-uFOY/gviz/tq?tqx=out:csv&sheet=All";
const REPO = "https://github.com/timbergeron/QSS-M";

const VENDORED = new Set(["lodepng.c", "stb_image.h", "stb_image_write.h", "jsmn.h"]);

const COMMAND = /Cmd_AddCommand(\w*)\s*\(\s*"([^"]+)"/g;
const PARAM = /COM_CheckParm(?:Next)?\s*\(\s*(?:\w+\s*,\s*)?"(-[^"]+)"/g;

// Sheet categories are free text; fold them into a small, stable navigation set.
const CATEGORY_ALIASES = {
  visual: "Graphics", video: "Graphics",
  hud: "HUD", menu: "Menus",
  sound: "Sound", music: "Sound",
  mouse: "Input", movement: "Movement", weapons: "Movement",
  connection: "Network", network: "Network", communication: "Chat",
  server: "Server", demo: "Demos",
  developer: "Developer", internal: "Developer",
  utility: "Utility", misc: "Utility",
  singleplayer: "Single player", singeplayer: "Single player", gameplay: "Single player",
};

const PREFIX_CATEGORIES = [
  [/^(r_|gl_|vid_|fog|gamma|contrast|texture_|scr_sbaralpha)/, "Graphics"],
  [/^(scr_|sbar|crosshair|con_|viewsize|cl_crosshair|hud|showfps)/, "HUD"],
  [/^(snd_|s_|bgm|volume|mus|cd|_snd)/, "Sound"],
  [/^(in_|joy_|m_|sensitivity|lookspring|lookstrafe|freelook|\+|-|bind|unbind)/, "Input"],
  [/^(net_|cl_web|cl_net|rcon|connect|reconnect|ping|pq_)/, "Network"],
  [/^(sv_|pr_|host_|sys_ticrate|deathmatch|coop|teamplay|fraglimit|timelimit|skill|pm_)/, "Server"],
  [/^(say|chat|messagemode|cl_voip)/, "Chat"],
  [/^(record|stop|playdemo|timedemo|demo)/, "Demos"],
  [/^(menu_|togglemenu)/, "Menus"],
  [/^(cl_|chase_|v_|fov|zoom)/, "Movement"],
  [/^(developer|dev_|edict|profile|test)/, "Developer"],
];

function categoryFor(name, sheetCategory) {
  if (Object.values(CATEGORY_ALIASES).includes(sheetCategory)) return sheetCategory;
  const first = sheetCategory.toLowerCase().split(/[,/]/)[0].trim();
  if (CATEGORY_ALIASES[first]) return CATEGORY_ALIASES[first];
  for (const [pattern, category] of PREFIX_CATEGORIES) {
    if (pattern.test(name.toLowerCase())) return category;
  }
  return "Utility";
}

async function scanSource(revision) {
  const cvars = new Map();
  const commands = new Map();
  const params = new Map();
  const files = (await git("ls-tree", "-r", "--name-only", revision, "--", "Quake"))
    .split("\n").filter((file) => /\.(c|cpp|m)$/.test(file) && !VENDORED.has(path.basename(file))).sort();
  const header = await git("show", `${revision}:Quake/quakedef.h`);
  for (const file of files) {
    // Read the cited commit, including on a dirty checkout; never label local edits
    // as evidence from a commit that does not contain them.
    const text = await git("show", `${revision}:${file}`);
    for (const entry of scanCvars(text, { header, file })) if (!cvars.has(entry.name)) cvars.set(entry.name, entry);
    const code = stripComments(text);
    for (const match of code.matchAll(COMMAND)) {
      const [, variant, name] = match;
      if (commands.has(name)) continue;
      const scope = /Server/.test(variant) ? "server" : /Client/.test(variant) ? "client" : "";
      commands.set(name, { name, kind: "command", flags: scope ? [scope] : [], file, line: code.slice(0, match.index).split("\n").length });
    }
    for (const match of code.matchAll(PARAM)) {
      if (!params.has(match[1])) params.set(match[1], { name: match[1], kind: "param", flags: [], file, line: code.slice(0, match.index).split("\n").length });
    }
  }
  return { cvars, commands, params };
}

function sheetName(identifier) {
  return identifier.replace(/^\*+/, "").trim().split(/\s+/)[0].replace(/^"|"$/g, "");
}

async function loadSheet() {
  const previousNotes = async (file) => {
    const previous = JSON.parse(await readFile(file, "utf8"));
    return new Map(previous.entries.map((entry) => [entry.name.toLowerCase(), { engine: entry.origin, category: entry.category, description: entry.description, summary: entry.summary }]));
  };
  if (process.env.REFERENCE_NOTES_FILE) return previousNotes(path.resolve(process.env.REFERENCE_NOTES_FILE));
  let text;
  try {
    const response = await fetch(SHEET_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    console.warn(`Sheet unavailable (${error.message}); retaining the prepared reference notes`);
    return previousNotes(path.join(output, "reference.json"));
  }
  const rows = new Map();
  for (const record of csvToRecords(text).records) {
    const identifier = record.get("Console Variables", "Command / Variable", "Name");
    const name = sheetName(identifier);
    const type = record.get("Type");
    if (!name || !type || type === "Type" || rows.has(name.toLowerCase())) continue;
    rows.set(name.toLowerCase(), {
      engine: record.get("Engine").replace(/^\*/, ""),
      category: record.get("Category"),
      type,
      description: record.get("Description"),
      summary: record.get("Short JSON Description"),
    });
  }
  return rows;
}

async function git(...args) {
  const { stdout } = await run("git", ["-C", qssm, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return args[0] === "show" ? stdout : stdout.trim();
}

async function versionString(revision) {
  const header = await git("show", `${revision}:Quake/quakedef.h`);
  const part = (name) => header.match(new RegExp(`#define\\s+QSSM_VER_${name}\\s+(\\d+)`))?.[1];
  return [part("MAJOR"), part("MINOR"), part("PATCH")].every(Boolean)
    ? `${part("MAJOR")}.${part("MINOR")}.${part("PATCH")}`
    : "";
}

async function main() {
  const commit = await git("log", "-1", "--format=%H|%cI|%s", process.env.QSSM_REF || "HEAD");
  const [sha, committedAt, subject] = commit.split("|");
  const [{ cvars, commands, params }, sheet, version, log, overrides] = await Promise.all([
    scanSource(sha),
    loadSheet(),
    versionString(sha),
    git("log", "-40", "--no-merges", "--format=%H|%cI|%s", sha),
    readFile(path.join(root, "reference", "overrides.json"), "utf8").then(JSON.parse),
  ]);

  // Fixed-length short hashes: git's %h length varies by clone, which would make
  // every CI refresh look like a change.
  const shortSha = sha.slice(0, 9);
  const entries = [];
  for (const item of [...cvars.values(), ...commands.values(), ...params.values()]) {
    const notes = sheet.get(item.name.toLowerCase()) || {};
    const reviewed = overrides[item.name.toLowerCase()] || {};
    entries.push({
      ...item,
      category: item.kind === "param" ? "Launch options" : categoryFor(item.name, notes.category || ""),
      origin: notes.engine || "",
      summary: reviewed.summary ?? notes.summary ?? "",
      description: reviewed.description ?? notes.description ?? "",
      url: `${REPO}/blob/${shortSha}/${item.file}#L${item.line}`,
    });
  }
  entries.sort((a, b) => a.name.replace(/^[+-]/, "").localeCompare(b.name.replace(/^[+-]/, "")));

  // Keep rebuilds deterministic: only source, sheet, or local prose changes
  // should change the published reference.
  const reference = {
    source: { repo: REPO, sha, shortSha, committedAt, subject, version },
    counts: {
      cvars: cvars.size,
      commands: commands.size,
      params: params.size,
      described: entries.filter((entry) => entry.description || entry.summary).length,
    },
    entries,
    changes: log.split("\n").filter(Boolean).map((line) => {
      const [hash, date, ...rest] = line.split("|");
      return { hash: hash.slice(0, 9), date, subject: rest.join("|"), url: `${REPO}/commit/${hash}` };
    }),
  };

  await mkdir(output, { recursive: true });
  const destination = path.join(output, "reference.json");
  const staging = `${destination}.${process.pid}.building`;
  await writeFile(staging, `${JSON.stringify(reference, null, 1)}\n`);
  await rename(staging, destination);
  console.log(
    `QSS-M ${version} @ ${shortSha}: ${cvars.size} cvars, ${commands.size} commands, ` +
    `${params.size} launch options (${reference.counts.described} with descriptions)`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
