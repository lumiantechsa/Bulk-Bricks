// OpenAI (Chat Completions API) version of the agent loop.
import { toolDefinitions } from "../tools.js";

export const defaultModel = "gpt-5.5";

const tools = toolDefinitions.map(({ name, description, input_schema, strict }) => ({
  type: "function",
  function: { name, description, parameters: input_schema, strict },
}));

export function appendUserInput(messages, texts) {
  messages.push({ role: "user", content: texts.join("\n\n") });
}

/** One model call. Returns the reply text, or the tool calls to run next. */
export async function step({ client, model, conv }) {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: conv.system }, ...conv.messages],
    tools,
  });
  const message = response.choices[0].message;
  if (message.refusal) return { refused: true };

  conv.messages.push({
    role: "assistant",
    content: message.content ?? null,
    ...(message.tool_calls?.length && { tool_calls: message.tool_calls }),
  });
  if (!message.tool_calls?.length) return { toolCalls: null, text: message.content?.trim() ?? "" };

  const toolCalls = message.tool_calls.map((tc) => {
    let input;
    let parseError;
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      parseError = `Arguments for ${tc.function.name} were not valid JSON.`;
    }
    return { id: tc.id, name: tc.function.name, input, parseError };
  });
  return { toolCalls, text: message.content?.trim() ?? "" };
}

export function appendToolResults(messages, results) {
  for (const { id, content } of results) {
    messages.push({ role: "tool", tool_call_id: id, content });
  }
}

export function appendAssistantText(messages, text) {
  messages.push({ role: "assistant", content: text });
}
