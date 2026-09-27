import { createHash } from "node:crypto";

export class OpenRouterError extends Error {
  constructor(message, status = 500, cost = 0) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.cost = cost;
  }
}

async function readResponse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new OpenRouterError(
      body?.error?.message || body?.message || "OpenRouter request failed",
      response.status,
    );
  }
  return body;
}

export class OpenRouterClient {
  constructor({
    model,
    maxOutputTokens,
    retryOutputTokens,
    requestTimeoutMs = 90_000,
    publicUrl,
    appTitle = "QSS-M Wiki",
    logger = console,
    now = Date.now,
  }) {
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.retryOutputTokens = Math.max(
      maxOutputTokens,
      retryOutputTokens || maxOutputTokens * 2,
    );
    this.requestTimeoutMs = requestTimeoutMs;
    this.publicUrl = publicUrl;
    this.appTitle = appTitle;
    this.logger = logger;
    this.now = now;
  }

  async requestCompletion({ apiKey, messages, sessionId, userId, maxCompletionTokens, model }) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.publicUrl,
        "X-Title": this.appTitle,
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: maxCompletionTokens,
        ...(!model.startsWith("openai/gpt-6-") && { temperature: 0.35 }),
        ...(sessionId && { session_id: sessionId }),
        ...(userId && {
          user: createHash("sha256").update(String(userId)).digest("hex").slice(0, 32),
        }),
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    return readResponse(response);
  }

  async complete({ apiKey, messages, sessionId, userId, model = "" }) {
    const limits = [...new Set([this.maxOutputTokens, this.retryOutputTokens])];
    const selectedModel = model.trim() || this.model;
    let totalCost = 0;

    for (let attempt = 0; attempt < limits.length; attempt += 1) {
      const attemptNumber = attempt + 1;
      const maxCompletionTokens = limits[attempt];
      const startedAt = this.now();
      let body;
      try {
        body = await this.requestCompletion({
          apiKey,
          messages,
          sessionId,
          userId,
          maxCompletionTokens,
          model: selectedModel,
        });
      } catch (error) {
        this.logger.error?.("OpenRouter completion attempt failed", {
          model: selectedModel,
          attempt: attemptNumber,
          maxCompletionTokens,
          elapsedMs: Math.max(0, this.now() - startedAt),
          error: error?.message || String(error),
          status: Number(error?.status) || undefined,
        });
        throw error;
      }
      totalCost += Number(body?.usage?.cost) || 0;
      const choice = body?.choices?.[0] || {};
      const content = choice.message?.content;
      const finishReason = choice.finish_reason || choice.native_finish_reason || "";
      const reasoningTokens = Number(
        body?.usage?.completion_tokens_details?.reasoning_tokens,
      ) || 0;
      const completionTokens = Number(body?.usage?.completion_tokens) || 0;
      const text = Array.isArray(content)
        ? content.map((part) => part?.text || "").join("")
        : content;
      const complete = Boolean(text?.trim()) && finishReason !== "length";
      const attemptDetails = {
        model: body?.model || selectedModel,
        attempt: attemptNumber,
        maxCompletionTokens,
        elapsedMs: Math.max(0, this.now() - startedAt),
        finishReason: finishReason || "empty",
        contentCharacters: typeof text === "string" ? text.length : 0,
        completionTokens,
        reasoningTokens,
      };

      this.logger.info?.("OpenRouter completion attempt finished", attemptDetails);

      if (complete) {
        return {
          text: text.trim(),
          cost: totalCost,
          model: body?.model || selectedModel,
        };
      }

      if (attempt + 1 < limits.length) {
        this.logger.warn?.("Retrying truncated OpenRouter completion", {
          ...attemptDetails,
          nextMaxCompletionTokens: limits[attempt + 1],
        });
        continue;
      }

      const reason = finishReason === "length"
        ? `The model exhausted ${maxCompletionTokens} completion tokens before finishing`
        : "The model returned an empty answer";
      throw new OpenRouterError(reason, 502, totalCost);
    }

    throw new OpenRouterError("The model returned an empty answer", 502);
  }

  async validateKey(apiKey) {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return readResponse(response);
  }
}
