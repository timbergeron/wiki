import { readEvents } from "../site/stream.js";

export async function readCompletion(body, { onDelta, onCost }) {
  let finish = "", done = false, text = "";
  for await (const frame of readEvents(body)) {
    if (frame.data === "[DONE]") { done = true; break; }
    const chunk = JSON.parse(frame.data);
    // The final accounting frame can repeat finish_reason. Count its cost once.
    if (chunk.usage && Number.isFinite(chunk.usage.cost) && chunk.usage.cost >= 0) onCost(chunk.usage.cost);
    if (chunk.error) throw new Error(chunk.error.message || "Provider error");
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (choice?.delta?.content) { text += choice.delta.content; onDelta(choice.delta.content); }
  }
  if (!done || finish !== "stop" || !text.trim()) {
    throw new Error(finish === "length" ? "The answer reached its limit before finishing. Try a more specific question." : "The answer was interrupted. Try again.");
  }
}
