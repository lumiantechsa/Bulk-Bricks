// Claude (Anthropic Messages API) version of the agent loop.
import { toolDefinitions } from "../tools.js";

export const defaultModel = "claude-opus-5-5";

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

export function appendUserInput(messages, texts) {
  const blocks = texts.map((text) => ({ type: "text", text }));
  const last = messages.at(-1);
  // If the previous run stopped on tool results, extend that user turn rather
  // than sending two user turns in a row.
  if (last?.role === "user") last.content.push(...blocks);
  else messages.push({ role: "user", content: blocks });
}

/** One model call. Returns the reply text, or the tool calls to run next. */
export async function step({ client, model, conv }) {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    system: conv.system,
    tools: toolDefinitions,
    messages: conv.messages,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    // Re-run on Anthropic's recommended model if a safety classifier declines.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  if (response.stop_reason === "refusal") return { refused: true };
  conv.messages.push({ role: "assistant", content: response.content });
  if (response.stop_reason === "pause_turn") return { toolCalls: [], text: "" };
  const toolCalls =
    response.stop_reason === "tool_use"
      ? response.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }))
      : null;
  return { toolCalls, text: textOf(response.content) };
}

export function appendToolResults(messages, results) {
  messages.push({
    role: "user",
    content: results.map(({ id, content, isError }) => ({
      type: "tool_result",
      tool_use_id: id,
      content,
      ...(isError && { is_error: true }),
    })),
  });
}

export function appendAssistantText(messages, text) {
  messages.push({ role: "assistant", content: [{ type: "text", text }] });
}
