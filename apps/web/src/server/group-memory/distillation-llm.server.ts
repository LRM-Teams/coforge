import type { DistillationMessages } from "./distillation-prompts.server";
import type { ResolvedWorkspaceModelCredential } from "./workspace-model-configuration.server";

/**
 * The distillation worker's single LLM seam. Production dials an
 * OpenAI-compatible chat-completions endpoint with the Workspace model
 * credential (ADR 0052); tests inject a fixture implementation, so golden
 * prompt tests never need a live model. Every call is JSON-mode: the worker
 * treats a non-JSON or invalid response as a failed pass, never as silent
 * garbage (ADR 0053-E red line: a failed pass degrades to "try again next
 * sweep", it never corrupts memory).
 */

export type DistillationLlmRequest = {
  credential: ResolvedWorkspaceModelCredential;
  messages: DistillationMessages;
  maxTokens?: number;
};

export interface DistillationLlm {
  completeJson<T>(request: DistillationLlmRequest): Promise<T>;
}

export class DistillationLlmError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DistillationLlmError";
  }
}

export class OpenAiCompatibleDistillationLlm implements DistillationLlm {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async completeJson<T>(request: DistillationLlmRequest): Promise<T> {
    const { credential } = request;
    const url = `${credential.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential.apiKey ? { authorization: `Bearer ${credential.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: credential.model,
          messages: request.messages,
          temperature: 0.1,
          response_format: { type: "json_object" },
          ...(credential.reasoning ? { reasoning_effort: credential.reasoning } : {}),
          // Reasoning models can burn the whole budget on hidden reasoning
          // and return empty content; a generous default bounds that class
          // of failure without changing shorter-model behavior materially.
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : { max_tokens: 4096 }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DistillationLlmError("distillation model call failed", error);
    }
    if (!response.ok)
      throw new DistillationLlmError(`distillation model call returned ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DistillationLlmError("distillation model response was not JSON", error);
    }
    const content = extractMessageContent(payload);
    if (typeof content !== "string")
      throw new DistillationLlmError("distillation model response had no message content");
    try {
      return JSON.parse(content) as T;
    } catch (error) {
      throw new DistillationLlmError("distillation model content was not valid JSON", error);
    }
  }
}

function extractMessageContent(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const choices = Reflect.get(payload, "choices");
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = Reflect.get(choices[0], "message");
  if (!message || typeof message !== "object") return undefined;
  return Reflect.get(message, "content");
}
