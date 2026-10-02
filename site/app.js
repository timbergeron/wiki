import { searchGuide, tokens } from "./search.js";
import { escapeHtml, highlight } from "./highlight.js";
import { defaultLabel, tryLine } from "./reference.js";
import { readAnswerStream } from "./stream.js";

const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
};

const ICON = {
  chev: '<svg viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  q: '<svg viewBox="0 0 24 24"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><path d="M12 18h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const KIND_LABEL = { cvar: "variable", command: "command", param: "launch option" };
const state = {
  reference: null,
  faq: [],
  byName: new Map(),
  ask: false,
  askBase: (window.QSSM_GUIDE?.askEndpoint || ".").replace(/\/$/, ""),
  kind: "all",
  category: "All",
  refQuery: "",
  refLimit: 60,
  selection: -1,
  items: [],
};

/* ---------------- markdown (tiny, safe) ---------------- */
function inline(text, citations) {
  const codes = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[(\d+)\]/g, (match, number) => {
      const source = citations?.[Number(number) - 1];
      if (!source) return "";
      return `<a class="cite" href="${escapeHtml(source.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(source.label)}">${number}</a>`;
    });
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => {
    const code = codes[Number(index)];
    const name = code.trim().split(/\s+/)[0].replace(/^"|"$/g, "").toLowerCase();
    return state.byName.has(name)
      ? `<a href="#ref/${encodeURIComponent(name)}" class="ref-link" title="Open in console reference"><code class="linked" data-ref="${escapeHtml(name)}">${code}</code></a>`
      : `<code>${code}</code>`;
  });
}

function markdown(text, citations) {
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`); list = null; } };
  let paragraph = [];
  const flushParagraph = () => { if (paragraph.length) { blocks.push(`<p>${inline(paragraph.join(" "), citations)}</p>`); paragraph = []; } };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const numbered = line.match(/^\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(inline((bullet || numbered)[1], citations));
    } else if (!line) {
      flushParagraph();
      flush();
    } else {
      flush();
      paragraph.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushParagraph();
  flush();
  return blocks.join("");
}

function sourceChips(citations) {
  if (!citations?.length) return null;
  return el("div", { className: "sources" }, citations.map((source, index) =>
    el("a", { className: "source", href: source.url || "#", target: "_blank", rel: "noopener", title: source.label },
      el("b", { textContent: index + 1 }), el("span", { textContent: source.label }))));
}

/* ---------------- helpers ---------------- */
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

async function copy(text, message = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Couldn't copy");
  }
}

function relativeTime(iso) {
  const seconds = (Date.now() - new Date(iso)) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  return "just now";
}

function originClass(origin) {
  return origin === "QSS-M" ? "origin qssm" : "origin";
}

function summaryOf(entry) {
  const text = entry.summary || entry.description || "";
  return text.replace(/\s+/g, " ").trim();
}

/* ---------------- search ---------------- */
function searchAll(query) {
  return searchGuide(query, { faq: state.faq, entries: state.reference.entries });
}

function hideResults() {
  $("#results").hidden = true;
  $("#q").setAttribute("aria-expanded", "false");
  $("#q").removeAttribute("aria-activedescendant");
  state.selection = -1;
}

function renderResults() {
  const query = $("#q").value;
  const panel = $("#results");
  const matches = searchAll(query);
  state.items = matches.map((match) => ({ ...match }));
  const askable = state.ask && query.trim().length >= 3;
  if (askable) state.items.push({ type: "ask" });
  if (!query.trim()) {
    hideResults();
    return;
  }
  if (state.selection >= state.items.length) state.selection = -1;
  panel.replaceChildren(...state.items.map((result, index) => {
    const button = el("button", { type: "button", className: "result", role: "option", id: `result-${index}`, tabIndex: -1 });
    button.setAttribute("aria-selected", String(index === state.selection));
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => choose(index));
    if (result.type === "faq") {
      button.innerHTML = `<span class="result-icon faq">${ICON.q}</span>
        <span><div class="result-title">${highlight(result.item.question, query)}</div>
        <div class="result-sub">${escapeHtml(result.item.answer.replace(/\[\d+\]|`/g, "").slice(0, 140))}</div></span>
        <span class="result-meta">FAQ</span>`;
    } else if (result.type === "entry") {
      const entry = result.item;
      const letter = entry.kind === "cvar" ? "v" : entry.kind === "command" ? "c" : "−";
      button.innerHTML = `<span class="result-icon">${letter}</span>
        <span><div class="result-title"><code>${highlight(entry.name, query)}</code>${entry.kind === "cvar" ? ` <span class="result-meta">= ${escapeHtml(defaultLabel(entry))}</span>` : ""}</div>
        <div class="result-sub">${escapeHtml(summaryOf(entry) || KIND_LABEL[entry.kind])}</div></span>
        <span class="result-meta">${KIND_LABEL[entry.kind]}</span>`;
    } else {
      button.innerHTML = `<span class="result-icon ask">${ICON.spark}</span>
        <span><div class="result-title">Ask: “${escapeHtml(query.trim())}”</div>
        <div class="result-sub">Get an answer from the indexed QSS-M source</div></span>
        <span class="result-meta">↵</span>`;
    }
    return button;
  }));
  panel.hidden = false;
  if (!state.items.length) panel.append(el("div", { className: "ref-empty", textContent: "No matches. Try a setting name or a shorter question." }));
  $("#q").setAttribute("aria-expanded", "true");
  if (state.selection >= 0) {
    $("#q").setAttribute("aria-activedescendant", `result-${state.selection}`);
    document.getElementById(`result-${state.selection}`).scrollIntoView({ block: "nearest" });
  } else $("#q").removeAttribute("aria-activedescendant");
}

function choose(index) {
  const result = state.items[index];
  if (!result) return;
  hideResults();
  if (result.type === "faq") openFaq(result.item.id);
  else if (result.type === "entry") openEntry(result.item.name);
  else ask($("#q").value.trim());
}

/* ---------------- live answers ---------------- */
let activeAsk = null;

async function ask(question) {
  if (!question) return;
  if (!state.ask) {
    const [top] = searchAll(question);
    if (top) return top.type === "faq" ? openFaq(top.item.id) : openEntry(top.item.name);
    return toast("Try a setting name, like fov or crosshair");
  }
  activeAsk?.abort();
  const controller = new AbortController();
  activeAsk = controller;
  hideResults();

  const wrap = $("#answer");
  const body = el("div", { className: "prose cursor" });
  const status = el("div", { className: "answer-status" }, el("span", { className: "pulse" }), "Reading the source…");
  const close = el("button", { className: "icon-button", type: "button", innerHTML: ICON.close, ariaLabel: "Close answer" });
  close.addEventListener("click", () => { controller.abort(); wrap.hidden = true; });
  const card = el("article", { className: "answer-card" },
    el("div", { className: "answer-q" }, el("h3", { textContent: question }), close),
    status, body);
  wrap.replaceChildren(card);
  wrap.hidden = false;
  requestAnimationFrame(() => wrap.scrollIntoView({ behavior: "smooth", block: "nearest" }));

  let sources = [];
  let text = "";
  const paint = () => {
    const citations = sources.map((source) => source);
    body.innerHTML = markdown(text, citations);
  };
  try {
    const response = await fetch(`${state.askBase}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Live answers are unavailable right now.");
    }
    await readAnswerStream(response.body, {
      onSources: (data) => { sources = data; },
      onDelta: (data) => {
        if (!text) status.remove();
        text += data;
        paint();
      },
    });
    body.classList.remove("cursor");
    // Keep only the sources the answer cited, in citation order.
    const used = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => sources[n - 1]);
    const remap = new Map(used.map((n, i) => [n, i + 1]));
    text = text.replace(/\[(\d+)\]/g, (m, n) => (remap.has(Number(n)) ? `[${remap.get(Number(n))}]` : ""));
    const cited = used.map((n) => sources[n - 1]);
    body.innerHTML = markdown(text, cited);
    card.append(...[sourceChips(cited)].filter(Boolean),
      el("p", { className: "answer-note", textContent: `Written just now from QSS-M @ ${state.reference.source.shortSha}. Double-check anything important in the console.` }));
  } catch (error) {
    if (controller.signal.aborted) return;
    body.classList.remove("cursor");
    status.remove();
    body.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    const matches = searchAll(question).slice(0, 4);
    if (matches.length) {
      body.insertAdjacentHTML("beforeend", "<p>These might help:</p>");
      const list = el("ul");
      for (const match of matches) {
        const label = match.type === "faq" ? match.item.question : match.item.name;
        const link = el("a", { href: "#", textContent: label });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          match.type === "faq" ? openFaq(match.item.id) : openEntry(match.item.name);
        });
        list.append(el("li", {}, link));
      }
      body.append(list);
    }
  }
}

/* ---------------- FAQ ---------------- */
function renderFaq() {
  const list = $("#faq-list");
  const toc = $("#faq-toc");
  if (!state.faq.length) {
    toc.hidden = true;
    list.parentElement.classList.add("single");
    list.replaceChildren(el("div", { className: "empty", innerHTML:
      "FAQ answers are being prepared. Until then, use search and the console reference below." }));
    return;
  }
  const sections = [...new Set(state.faq.map((item) => item.section))];
  toc.replaceChildren(...sections.map((section) =>
    el("a", { href: `#faq-${slug(section)}`, textContent: section })));
  list.replaceChildren(...sections.map((section) => el("div", { className: "faq-group", id: `faq-${slug(section)}` },
    el("h3", { textContent: section }),
    state.faq.filter((item) => item.section === section).map(faqItem))));
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function faqItem(item) {
  const details = el("details", { className: "faq-item", id: `faq/${item.id}` });
  const summary = el("summary", {}, el("span", { textContent: item.question }), el("span", { className: "chev", innerHTML: ICON.chev }));
  const body = el("div", { className: "faq-body" });
  details.append(summary, body);
  details.addEventListener("toggle", () => {
    if (!details.open || body.childElementCount) return;
    const prose = el("div", { className: "prose", innerHTML: markdown(item.answer, item.citations) });
    const cited = new Set((item.citations || []).map((source) => source.label.toLowerCase()));
    const extra = (item.related || []).filter((name) => !cited.has(name.toLowerCase()));
    const related = el("div", { className: "related" }, extra.slice(0, 6).map((name) => {
      const button = el("button", { type: "button", textContent: name, title: "Open in console reference" });
      button.addEventListener("click", () => openEntry(name));
      return button;
    }));
    const link = el("button", { type: "button", className: "copy-link", textContent: "Copy link" });
    link.addEventListener("click", () => copy(`${location.origin}${location.pathname}#faq/${item.id}`, "Link copied"));
    body.append(prose, sourceChips(item.citations) || "", el("div", { className: "faq-foot" }, related, link));
  });
  return details;
}

function openFaq(id) {
  const details = document.getElementById(`faq/${id}`);
  if (!details) return;
  details.open = true;
  history.replaceState(null, "", `#faq/${id}`);
  details.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- console reference ---------------- */
function filteredEntries() {
  const q = state.refQuery.trim().toLowerCase();
  const words = tokens(q);
  return state.reference.entries.filter((entry) => {
    if (entry.kind === "param") return false;
    if (state.kind !== "all" && entry.kind !== state.kind) return false;
    if (state.category !== "All" && entry.category !== state.category) return false;
    if (!q) return true;
    const hay = `${entry.name} ${entry.summary} ${entry.description}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  }).sort((a, b) => {
    if (!q) return 0;
    const rank = (entry) => (entry.name.toLowerCase() === q ? 0 : entry.name.toLowerCase().startsWith(q) ? 1 : entry.name.toLowerCase().includes(q) ? 2 : 3);
    return rank(a) - rank(b);
  });
}

function refRow(entry) {
  const row = el("div", { className: "ref-row", id: `ref/${entry.name}` });
  const summary = summaryOf(entry);
  const button = el("button", { type: "button" });
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="ref-name">${escapeHtml(entry.name)}</span>
    <span class="ref-sum${summary ? "" : " none"}">${escapeHtml(summary || "No description yet")}</span>
    <span class="ref-tags">${entry.kind === "cvar" ? `<span class="pill" title="${escapeHtml(defaultLabel(entry))}">${escapeHtml(defaultLabel(entry))}</span>` : ""}${entry.origin ? `<span class="${originClass(entry.origin)}">${escapeHtml(entry.origin)}</span>` : ""}</span>`;
  button.addEventListener("click", () => toggleRow(row, entry));
  row.append(button);
  return row;
}

function toggleRow(row, entry, force) {
  const open = force ?? !row.classList.contains("open");
  row.classList.toggle("open", open);
  row.firstElementChild.setAttribute("aria-expanded", String(open));
  row.querySelector(".ref-detail")?.remove();
  if (!open) return;
  const line = tryLine(entry);
  const tryIt = el("div", { className: "try" }, el("span", { textContent: line }));
  const copyButton = el("button", { type: "button", textContent: "Copy" });
  copyButton.addEventListener("click", () => copy(line));
  tryIt.append(copyButton);
  const facts = el("div", { className: "ref-facts" });
  facts.innerHTML = [
    `<span><b>Type</b> ${KIND_LABEL[entry.kind]}</span>`,
    entry.kind === "cvar" ? `<span><b>Default</b> <code>${escapeHtml(defaultLabel(entry))}</code></span>` : "",
    entry.flags.includes("saved") ? "<span><b>Saved</b> to config.cfg</span>" : "",
    entry.flags.includes("serverinfo") ? "<span><b>Server</b> info</span>" : "",
    entry.origin ? `<span><b>From</b> ${escapeHtml(entry.origin)}</span>` : "",
    `<span><b>Source</b> <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${escapeHtml(entry.file)}:${entry.line} ↗</a></span>`,
  ].join("");
  const share = el("a", { href: `#ref/${entry.name}`, textContent: "Link" });
  share.addEventListener("click", (event) => {
    event.preventDefault();
    copy(`${location.origin}${location.pathname}#ref/${entry.name}`, "Link copied");
  });
  facts.append(share);
  const detail = el("div", { className: "ref-detail" },
    entry.description || entry.summary ? el("p", { textContent: entry.description || entry.summary }) : el("p", { className: "ref-sum none", textContent: "Nobody has written a description for this one yet — the source link shows exactly what it does." }),
    entry.kind !== "param" ? tryIt : null,
    facts);
  row.append(detail);
}

function renderReference() {
  const matches = filteredEntries();
  const list = $("#ref-list");
  const shown = matches.slice(0, state.refLimit);
  list.replaceChildren(...(shown.length ? shown.map(refRow) : [el("div", { className: "ref-empty", textContent: "Nothing matches. Try a shorter word." })]));
  const more = $("#ref-more");
  more.hidden = matches.length <= state.refLimit;
  more.textContent = `Show ${Math.min(120, matches.length - state.refLimit)} more of ${matches.length - state.refLimit}`;
}

function renderCategories() {
  const counts = new Map();
  for (const entry of state.reference.entries) {
    if (entry.kind === "param") continue;
    counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  }
  const names = ["All", ...[...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))];
  $("#category-filter").replaceChildren(...names.map((name) => {
    const chip = el("button", { type: "button", className: "chip" }, name, name === "All" ? null : el("small", { textContent: counts.get(name) }));
    chip.setAttribute("aria-pressed", String(state.category === name));
    chip.addEventListener("click", () => {
      state.category = name;
      state.refLimit = 60;
      renderCategories();
      renderReference();
    });
    return chip;
  }));
}

function openEntry(name) {
  const entry = state.byName.get(name.toLowerCase());
  if (!entry) return;
  let row;
  if (entry.kind === "param") {
    row = document.getElementById(`ref/${entry.name}`);
  } else {
    state.kind = "all";
    state.category = "All";
    state.refQuery = entry.name;
    state.refLimit = 60;
    $("#ref-q").value = entry.name;
    for (const button of $("#kind-filter").children) button.setAttribute("aria-pressed", String(button.dataset.kind === "all"));
    renderCategories();
    renderReference();
    row = document.getElementById(`ref/${entry.name}`);
  }
  if (!row) return;
  toggleRow(row, entry, true);
  history.replaceState(null, "", `#ref/${entry.name}`);
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

function renderLaunch() {
  const params = state.reference.entries.filter((entry) => entry.kind === "param")
    .sort((a, b) => Number(!summaryOf(a)) - Number(!summaryOf(b)) || a.name.localeCompare(b.name));
  $("#launch-list").replaceChildren(...params.map(refRow));
}

function renderTimeline() {
  $("#timeline").replaceChildren(...state.reference.changes.slice(0, 12).map((change) =>
    el("li", {},
      el("a", { href: change.url, target: "_blank", rel: "noopener", textContent: change.subject }),
      el("time", { dateTime: change.date, title: new Date(change.date).toLocaleString() }, relativeTime(change.date), el("code", { textContent: change.hash })))));
}

/* ---------------- chrome ---------------- */
function renderMeta() {
  const { source, counts } = state.reference;
  const eyebrow = $("#version-line");
  eyebrow.innerHTML = `<span class="dot"></span> QSS-M ${escapeHtml(source.version)} · last commit ${escapeHtml(relativeTime(source.committedAt))} · <a href="${escapeHtml(source.repo)}/commit/${escapeHtml(source.sha)}" target="_blank" rel="noopener">${escapeHtml(source.shortSha)}</a>`;
  $("#console-sub").textContent = `${counts.cvars} variables and ${counts.commands} commands in this source revision — defaults straight from the code.`;
  $("#foot-source").innerHTML = `Built from <a href="${escapeHtml(source.repo)}" target="_blank" rel="noopener">QSS-M</a> ${escapeHtml(source.version)} at <code>${escapeHtml(source.shortSha)}</code>, ${escapeHtml(new Date(source.committedAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }))}.`;

  const PICKS = [["crosshair", "Crosshair"], ["fov", "Field of view"], ["fps", "Uncap FPS"], ["connect", "Join a server"], ["demo", "Record demos"]];
  const picks = PICKS.map(([id, label]) => [state.faq.find((item) => item.id === id), label]).filter(([item]) => item);
  const fallback = ["How do I change my crosshair?", "fov", "record", "connect", "host_maxfps"];
  $("#suggestions").replaceChildren(...(picks.length ? picks.map(([item, label]) => {
    const button = el("button", { type: "button", className: "suggestion", textContent: label });
    button.addEventListener("click", () => openFaq(item.id));
    return button;
  }) : fallback.map((text) => {
    const button = el("button", { type: "button", className: "suggestion", textContent: text });
    button.addEventListener("click", () => { $("#q").value = text; $("#q").focus(); renderResults(); });
    return button;
  })));
}

function wire() {
  const input = $("#q");
  input.addEventListener("input", () => { state.selection = -1; renderResults(); });
  input.addEventListener("focus", renderResults);
  input.addEventListener("blur", hideResults);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = state.items.length;
      if (!count) return;
      state.selection = state.selection < 0 ? (event.key === "ArrowDown" ? 0 : count - 1) : (state.selection + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      renderResults();
    } else if (event.key === "Escape") {
      hideResults();
      input.blur();
    }
  });
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return input.focus();
    if (state.selection >= 0) return choose(state.selection);
    const [top] = searchAll(query);
    const exact = top?.type === "entry" && top.item.name.toLowerCase() === query.toLowerCase();
    if (exact || !state.ask) return top ? choose(0) : ask(query);
    ask(query);
  });

  const focusSearch = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => input.focus({ preventScroll: true }), 250);
  };
  $("#jump").addEventListener("click", focusSearch);
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $("#jump-key").textContent = "Ctrl K";
  document.addEventListener("keydown", (event) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
      event.preventDefault();
      focusSearch();
    }
  });

  $("#kind-filter").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.kind = button.dataset.kind;
    state.refLimit = 60;
    for (const other of $("#kind-filter").children) other.setAttribute("aria-pressed", String(other === button));
    renderReference();
  });
  let timer;
  $("#ref-q").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.refQuery = event.target.value; state.refLimit = 60; renderReference(); }, 80);
  });
  $("#ref-more").addEventListener("click", () => { state.refLimit += 120; renderReference(); });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a.ref-link");
    if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      openEntry(link.querySelector("code").dataset.ref);
    }
  });

  const bar = $("#bar");
  const onScroll = () => bar.classList.toggle("scrolled", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Highlight the nav/TOC entry for whatever is on screen.
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.id;
      for (const link of document.querySelectorAll(".nav a, .faq-toc a")) {
        const target = link.getAttribute("href").slice(1);
        if (link.closest(".nav") ? ["faq", "console", "launch", "changes"].includes(id) : id.startsWith("faq-")) {
          link.classList.toggle("active", target === id);
        }
      }
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  document.querySelectorAll(".section, .faq-group").forEach((node) => spy.observe(node));

  const route = () => {
    let hash;
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if (hash.startsWith("faq/")) openFaq(hash.slice(4));
    else if (hash.startsWith("ref/")) openEntry(hash.slice(4));
  };
  window.addEventListener("hashchange", route);
  if (location.hash) setTimeout(route, 150);
}

async function main() {
  const load = (file) => fetch(`data/${file}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [reference, faq] = await Promise.all([load("reference.json"), load("faq.json")]);
  if (!reference) {
    $("#version-line").textContent = "The guide couldn't load. Check your connection and try again.";
    $("#suggestions").replaceChildren(el("button", { type: "button", className: "suggestion", textContent: "Retry", onclick: () => location.reload() }));
    $("#q").disabled = true;
    $("#ask-button").disabled = true;
    return;
  }
  state.reference = reference;
  state.faq = (faq?.answers || []).filter((item) => item.answer);
  for (const entry of reference.entries) state.byName.set(entry.name.toLowerCase(), entry);

  renderMeta();
  renderFaq();
  renderCategories();
  renderReference();
  renderLaunch();
  renderTimeline();
  wire();

  fetch(`${state.askBase}/api/status`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).then((status) => {
    state.ask = Boolean(status?.ask);
    if (state.ask) $("#ask-button").textContent = "Ask";
    if (document.activeElement === $("#q")) renderResults();
  }).catch(() => {});
}

main();
