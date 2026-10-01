export const STOP = new Set("a an the how do i to my is in of and or can what does it on off for with where why you me turn enable disable set change adjust want use using please".split(" "));
export const tokens = (text) => String(text).toLowerCase().match(/[+-]?[a-z0-9_]+/g) || [];
const wordSet = (text) => new Set(tokens(text).flatMap((word) => [word, ...word.replace(/^[+-]/, "").split("_")]));

export function searchGuide(query, { faq, entries }) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = [...new Set(tokens(q).filter((word) => !STOP.has(word) && word.length > 1))];
  const natural = tokens(q).length > 1;
  const found = [];
  for (const item of faq) {
    const title = wordSet(item.question);
    const related = wordSet((item.related || []).join(" "));
    const body = wordSet(item.answer);
    const matches = words.filter((word) => title.has(word) || related.has(word) || body.has(word));
    let score = words.reduce((sum, word) => sum + (title.has(word) ? 10 : related.has(word) ? 6 : body.has(word) ? 1 : 0), 0);
    if (score) {
      score *= 1 + matches.length / words.length;
      if (natural && words.some((word) => title.has(word))) score *= 1.5;
      found.push({ type: "faq", item, score });
    }
  }
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const names = wordSet(name);
    const prose = wordSet(`${entry.summary || ""} ${entry.description || ""}`);
    let score = name === q ? 1000 : name.startsWith(q) ? 60 - Math.min(name.length - q.length, 20) : name.includes(q) ? 18 : 0;
    for (const word of words) {
      if (names.has(word)) score += 18;
      else if (name.includes(word) && !natural) score += 5;
      if (prose.has(word)) score += 1.2;
    }
    if (words.length > 1 && words.every((word) => names.has(word))) score += 30;
    if (score) found.push({ type: "entry", item: entry, score });
  }
  found.sort((a, b) => b.score - a.score);
  const answers = found.filter((item) => item.type === "faq").slice(0, 3);
  const references = found.filter((item) => item.type === "entry").slice(0, answers.length ? 4 : 6);
  return [...answers, ...references].sort((a, b) => b.score - a.score);
}
