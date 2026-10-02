import { STOP, tokens } from "./search.js";

export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function highlight(text, query) {
  const words = [...new Set(tokens(query).filter((word) => word.length > 1 && !STOP.has(word)))];
  if (!words.length) return escapeHtml(text);
  // Match plain text once: later terms must never match tags or HTML entities
  // inserted for earlier terms. Prefer longer terms when they overlap.
  const pattern = words.sort((a, b) => b.length - a.length).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  let html = "", end = 0;
  for (const match of String(text).matchAll(new RegExp(pattern, "ig"))) {
    html += escapeHtml(String(text).slice(end, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    end = match.index + match[0].length;
  }
  return html + escapeHtml(String(text).slice(end));
}
