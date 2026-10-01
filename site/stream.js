// Shared SSE framing for the browser and the Ask server. Buffer bytes and lines
// separately so UTF-8, CRLF, comments, and multiline data survive chunk boundaries.
export async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (data.length) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
    }
  }
  // An event without its terminating blank line is incomplete and isn't emitted.
}

export async function readAnswerStream(body, { onSources = () => {}, onDelta = () => {} } = {}) {
  let text = "", sources = [], complete = false;
  for await (const frame of readEvents(body)) {
    const data = JSON.parse(frame.data);
    if (frame.event === "fail") throw new Error(data.error || "The answer was interrupted. Try again.");
    if (frame.event === "sources") { sources = data; onSources(data); }
    if (frame.event === "delta") { text += data; onDelta(data); }
    if (frame.event === "done") { complete = true; break; }
  }
  if (!complete) throw new Error("The answer was interrupted. Try again.");
  if (!text.trim()) throw new Error("No answer came back. Try rephrasing.");
  return { text, sources };
}
