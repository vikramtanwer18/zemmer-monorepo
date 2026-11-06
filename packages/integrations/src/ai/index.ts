import OpenAI from "openai";

/**
 * OpenAI-compatible chat client (D-13): the platform admin sets base URL, model and key, so any
 * provider speaking the Chat Completions API works (OpenAI, Azure-compatible gateways, Groq,
 * Together, OpenRouter, a local Ollama/vLLM...). The model only ever receives the messages the
 * Copilot builds and the tool definitions; the client never logs prompts, answers or keys.
 */

export type AiToolDef = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
};

export type AiToolCall = { id: string; name: string; arguments: string };

export type AiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type AiCompletion = {
  content: string | null;
  toolCalls: AiToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
};

export type AiRequest = {
  messages: AiMessage[];
  tools?: AiToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
};

export interface AiClient {
  /** "openai" for a configured provider, "fake" for the development/CI fake. */
  readonly kind: "openai" | "fake";
  readonly model: string;
  complete(request: AiRequest): Promise<AiCompletion>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export type OpenAiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

function toOpenAi(
  messages: AiMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool")
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    return { role: m.role, content: m.content };
  });
}

/** A provider message without anything that could echo a key or a prompt. */
function safeMessage(err: unknown): { message: string; status: number | null } {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? null;
    const reason =
      status === 401 || status === 403
        ? "The provider refused the API key."
        : status === 404
          ? "The provider doesn't know this model or URL."
          : status === 429
            ? "The provider is rate limiting or out of credit."
            : status && status >= 500
              ? "The provider had an error."
              : "The provider rejected the request.";
    return { message: `${reason}${status ? ` (HTTP ${status})` : ""}`, status };
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return { message: "The provider didn't answer in time.", status: null };
  if (err instanceof OpenAI.APIConnectionError)
    return { message: "Couldn't reach the provider.", status: null };
  return { message: "The AI request failed.", status: null };
}

export function createOpenAiClient(config: OpenAiConfig): AiClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl.replace(/\/$/, ""),
    timeout: config.timeoutMs,
    maxRetries: 1,
  });
  // Newer OpenAI models want max_completion_tokens; most compatible servers want max_tokens.
  let tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";
  return {
    kind: "openai",
    model: config.model,
    async complete(req) {
      const send = () =>
        client.chat.completions.create(
          {
            model: config.model,
            messages: toOpenAi(req.messages),
            temperature: 0,
            [tokenParam]: req.maxTokens,
            ...(req.tools?.length
              ? {
                  tools: req.tools.map((t) => ({
                    type: "function" as const,
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.parameters,
                    },
                  })),
                  tool_choice: "auto" as const,
                }
              : {}),
          },
          { signal: req.signal },
        );
      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await send();
      } catch (err) {
        if (
          err instanceof OpenAI.APIError &&
          err.status === 400 &&
          /max_tokens/.test(String(err.message)) &&
          tokenParam === "max_tokens"
        ) {
          tokenParam = "max_completion_tokens";
          try {
            res = await send();
          } catch (again) {
            const s = safeMessage(again);
            throw new AiProviderError(s.message, s.status);
          }
        } else {
          const s = safeMessage(err);
          throw new AiProviderError(s.message, s.status);
        }
      }
      const choice = res.choices[0];
      const calls = (choice?.message.tool_calls ?? [])
        .filter(
          (
            c,
          ): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
            c.type === "function",
        )
        .map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        }));
      return {
        content: choice?.message.content ?? null,
        toolCalls: calls,
        usage: {
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
        },
        model: res.model || config.model,
      };
    },
  };
}

export type ConnectionTest = {
  ok: boolean;
  supportsTools: boolean | null;
  message: string;
  latencyMs: number;
};

/**
 * "Test connection": a tiny plain completion, then a tool-calling probe. Tool support is detected
 * from the provider's answer (a well-formed call to the probe tool), not from its name.
 */
export async function testAiConnection(
  client: AiClient,
): Promise<ConnectionTest> {
  const started = Date.now();
  try {
    const plain = await client.complete({
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 16,
    });
    if (!plain.content?.trim())
      return {
        ok: false,
        supportsTools: null,
        message: "The provider answered with nothing.",
        latencyMs: Date.now() - started,
      };
    const probe = await client.complete({
      messages: [
        {
          role: "system",
          content: "You can call tools. Call the tool when asked.",
        },
        { role: "user", content: "Call get_number with value 42." },
      ],
      tools: [
        {
          name: "get_number",
          description: "Returns the number it is given.",
          parameters: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      maxTokens: 64,
    });
    const call = probe.toolCalls.find((c) => c.name === "get_number");
    let supportsTools = false;
    if (call) {
      try {
        supportsTools =
          (JSON.parse(call.arguments) as { value?: unknown }).value === 42;
      } catch {
        supportsTools = false;
      }
    }
    return {
      ok: true,
      supportsTools,
      message: supportsTools
        ? `Connected to ${plain.model}. Tool calling works.`
        : `Connected to ${plain.model}, but it didn't call tools correctly: the Copilot will answer from a server-built summary.`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      supportsTools: null,
      message:
        err instanceof AiProviderError
          ? err.message
          : "The connection test failed.",
      latencyMs: Date.now() - started,
    };
  }
}

// --- fakes (development, CI, tests) -------------------------------------------------------------

/** A scripted fake: returns the given completions in order (tests drive tool calls exactly). */
export function scriptedAiClient(
  steps: (
    Partial<AiCompletion> | ((req: AiRequest) => Partial<AiCompletion>)
  )[],
): AiClient & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  let i = 0;
  return {
    kind: "fake",
    model: "scripted-fake",
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const step = steps[Math.min(i++, steps.length - 1)];
      const out = typeof step === "function" ? step(req) : (step ?? {});
      return {
        content: out.content ?? null,
        toolCalls: out.toolCalls ?? [],
        usage: out.usage ?? { promptTokens: 10, completionTokens: 5 },
        model: "scripted-fake",
      };
    },
  };
}

export type FakeRouter = (
  question: string,
) => { name: string; args: Record<string, unknown> }[];

/**
 * The deterministic development/CI fake. Round 1: picks tools with the given router (the same
 * keyword routing the Copilot uses for providers without tool calling). Round 2: writes a short
 * answer that only restates figures from the tool results. It never follows text inside data.
 */
export function fakeAiClient(
  router: FakeRouter,
  options: { supportsTools?: boolean } = {},
): AiClient {
  const supportsTools = options.supportsTools ?? true;
  return {
    kind: "fake",
    model: "fake-copilot",
    async complete(req) {
      const lastUser = [...req.messages]
        .reverse()
        .find((m) => m.role === "user");
      const question = lastUser?.content ?? "";
      const afterUser = req.messages.slice(
        req.messages.lastIndexOf(lastUser!) + 1,
      );
      const toolResults = afterUser.filter(
        (m): m is Extract<AiMessage, { role: "tool" }> => m.role === "tool",
      );
      const usage = {
        promptTokens: Math.ceil(JSON.stringify(req.messages).length / 4),
        completionTokens: 40,
      };
      if (supportsTools && req.tools?.length && toolResults.length === 0) {
        const calls = router(question).map((c, n) => ({
          id: `call_${n + 1}`,
          name: c.name,
          arguments: JSON.stringify(c.args),
        }));
        if (calls.length)
          return {
            content: null,
            toolCalls: calls,
            usage,
            model: "fake-copilot",
          };
      }
      // Answer from the data the server gave (tool results, or the fallback summary in the prompt).
      const blocks = toolResults.length
        ? toolResults.map((t) => t.content)
        : [question];
      const lines: string[] = [];
      for (const raw of blocks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.slice(raw.indexOf("{")));
        } catch {
          continue;
        }
        const r = parsed as { summary?: string; data?: { summary?: string } };
        const summary = r.summary ?? r.data?.summary;
        if (summary) lines.push(summary);
      }
      return {
        content: lines.length
          ? lines.join("\n")
          : "I don't have enough data to answer that.",
        toolCalls: [],
        usage,
        model: "fake-copilot",
      };
    },
  };
}
