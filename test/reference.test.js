import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { scanCvars } from "../src/reference-source.js";
import { defaultLabel, tryLine } from "../site/reference.js";
import { formatEntry } from "../src/evidence.js";

test("extracts multiline declarations, concatenated macro defaults, and cvar arrays without comments", () => {
  const source = `/* cvar_t fake = {"fake", "9"}; */
#define ORDER "shotgun axe " "lg"
static cvar_t order =
 {"cl_wheel_order", ORDER, CVAR_ARCHIVE};
cvar_t masters[] = { {"net_master1", ""}, {"net_master2", "https://example.test//path"}, {NULL} };
cvar_t dynamic = {"sv_public", NULL};
cvar_t missing = {"unresolved", UNKNOWN_DEFAULT};`;
  const entries = scanCvars(source, { file: "sample.c" });
  assert.deepEqual(entries.map((entry) => entry.name), ["cl_wheel_order", "net_master1", "net_master2", "sv_public", "unresolved"]);
  assert.equal(entries[0].default, "shotgun axe lg");
  assert.equal(entries[0].line, 3);
  assert.deepEqual(entries[0].flags, ["saved"]);
  assert.equal(entries[2].default, "https://example.test//path");
  assert.equal(entries[3].default, null);
  assert.equal(entries[4].defaultExpression, "UNKNOWN_DEFAULT");
});

test("resolves stringification from the engine header and honors platform branches with CRLF", () => {
  const header = '#define MAJOR 1\n#define MINOR 6\n#define STR_(x) #x\n#define STR(x) STR_(x)\n#define VERSION "QSS-M " STR(MAJOR) "." STR(MINOR)';
  const source = 'cvar_t engine={"pr_engine",VERSION};\r\n#ifdef __APPLE__\r\ncvar_t vbo={"r_part_vbo","0"};\r\n#else\r\ncvar_t vbo={"r_part_vbo","1"};\r\n#endif\r\n#if defined(_WIN32)\r\n#define QUALITY "5"\r\n#else\r\n#define QUALITY "1"\r\n#endif\r\ncvar_t sound={"snd_filterquality",QUALITY};';
  const [engine, vbo, sound] = scanCvars(source, { header });
  assert.equal(engine.default, "QSS-M 1.6");
  assert.equal(vbo.default, "1");
  assert.deepEqual(vbo.defaultByPlatform, { linux: "1", windows: "1", macos: "0" });
  assert.deepEqual(sound.defaultByPlatform, { linux: "1", windows: "5", macos: "1" });
  assert.match(defaultLabel(vbo), /0 \(macOS\)/);
  assert.equal(tryLine(vbo), "r_part_vbo", "don't copy a reset command with the wrong platform default");
  assert.match(formatEntry({ ...vbo, flags: [], line: 2 }), /macOS/);
});

test("continued macros retain their complete value and unknown build defaults remain explicit", () => {
  const source = '#define ORDER "axe " \\\n "shotgun"\n\ncvar_t order={"order",ORDER};\n#ifdef OPTIONAL_BUILD\ncvar_t optional={"optional","1"};\n#else\ncvar_t optional={"optional","0"};\n#endif';
  const [order, optional] = scanCvars(source);
  assert.equal(order.default, "axe shotgun");
  assert.equal(order.line, 4);
  assert.equal(optional.default, null);
  assert.match(defaultLabel(optional), /Build dependent/);
});

test("prepared reference contains the formerly missing variables and correct platform defaults", async () => {
  const reference = JSON.parse(await readFile(new URL("../site/data/reference.json", import.meta.url)));
  const entries = new Map(reference.entries.filter((entry) => entry.kind === "cvar").map((entry) => [entry.name, entry]));
  for (const name of ["cl_wheel_order", "snd_filterquality", "pr_engine", "cl_display_server_hostnames", "r_showhull", "sv_public", "net_master1"]) assert.ok(entries.has(name), name);
  assert.equal(entries.get("r_part_vbo").defaultByPlatform.macos, "0");
  assert.equal(entries.get("r_part_vbo").defaultByPlatform.windows, "1");
  assert.equal(entries.get("snd_filterquality").defaultByPlatform.windows, "5");
});
