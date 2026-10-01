const PLATFORM_NAMES = { linux: "Linux", windows: "Windows", macos: "macOS" };

export function defaultLabel(entry) {
  const value = (text) => text === null ? "Set at startup" : text === "" ? '""' : String(text);
  if (entry.defaultByPlatform) {
    const groups = new Map();
    for (const [platform, text] of Object.entries(entry.defaultByPlatform)) {
      const label = value(text);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(PLATFORM_NAMES[platform] || platform);
    }
    return [...groups].map(([label, names]) => `${label} (${names.join("/")})`).join("; ");
  }
  if (entry.default === null && entry.defaultExpression !== "NULL") return `Build dependent (${entry.defaultExpression || "unknown"})`;
  return value(entry.default);
}

export function tryLine(entry) {
  if (entry.kind !== "cvar" || entry.default === null || entry.defaultByPlatform) return entry.name;
  return `${entry.name} "${entry.default.replaceAll('"', '\\"')}"`;
}
