import { requestUrl } from "obsidian";
import type { AiGatewaySettings, AiInlineMedia, AiMessage, AiProviderCredentials, AiProviderId } from "./types";

export async function callProvider(
  provider: AiProviderId,
  settings: AiGatewaySettings,
  credentials: AiProviderCredentials,
  messages: AiMessage[],
  schema: Record<string, unknown>,
  media: AiInlineMedia[] = [],
): Promise<{ text: string; model: string }> {
  if (media.length && provider !== "gemini") throw new Error(`${provider} does not support TPS inline image requests.`);
  if (provider === "ollama") {
    if (!settings.ollamaEnabled) throw new Error("Ollama is disabled.");
    const response = await requestUrl({ url: `${settings.ollamaUrl}/api/chat`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: settings.ollamaModel, stream: false, format: schema, messages: collapseSystemMessages(messages, schema), options: { temperature: 0 } }) });
    return { text: String(response.json?.message?.content || "").trim(), model: settings.ollamaModel };
  }
  if (provider === "openai") {
    if (!credentials.openAiApiKey) throw new Error("OpenAI is not configured.");
    const { instructions: system, rest } = splitSystemMessages(messages);
    const input = rest.map((message) => ({ role: message.role, content: message.content }));
    const response = await requestUrl({ url: "https://api.openai.com/v1/responses", method: "POST", headers: { Authorization: `Bearer ${credentials.openAiApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: settings.openAiModel, reasoning: { effort: "medium" }, instructions: system, input, text: { format: { type: "json_schema", name: "tps_gateway_result", strict: true, schema } } }) });
    const text = response.json?.output_text || response.json?.output?.flatMap((entry: any) => entry.content || []).find((entry: any) => entry.type === "output_text")?.text || "";
    return { text: String(text).trim(), model: settings.openAiModel };
  }
  if (!credentials.geminiApiKey) throw new Error("Gemini is not configured.");
  const { instructions: system, rest } = splitSystemMessages(messages);
  const contents: Array<{ role: "model" | "user"; parts: Array<Record<string, unknown>> }> = rest.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
  if (media.length) {
    let targetIndex = -1;
    for (let index = contents.length - 1; index >= 0; index -= 1) {
      if (contents[index].role === "user") {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex < 0) {
      contents.push({ role: "user", parts: [] });
      targetIndex = contents.length - 1;
    }
    contents[targetIndex].parts.push(...media.map((item) => ({ inline_data: { mime_type: item.mimeType, data: item.data } })));
  }
  const response = await requestUrl({ url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`, method: "POST", headers: { "x-goog-api-key": credentials.geminiApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema } }) });
  const text = response.json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "";
  return { text: String(text).trim(), model: settings.geminiModel };
}

function collapseSystemMessages(messages: AiMessage[], schema: Record<string, unknown>): AiMessage[] {
  const { instructions, rest } = splitSystemMessages(messages);
  const grounding = `${instructions}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}`.trim();
  return [{ role: "user", content: grounding }, ...rest];
}

function splitSystemMessages(messages: AiMessage[]): {
  instructions: string;
  rest: AiMessage[];
} {
  const systemContents: string[] = [];
  const rest: AiMessage[] = [];
  messages.forEach((message) => {
    if (message.role === "system") {
      systemContents.push(message.content);
    } else {
      rest.push(message);
    }
  });
  return { instructions: systemContents.join("\n"), rest };
}
