import { requestUrl } from "obsidian";
import type { AiGatewaySettings, AiMessage, AiProviderCredentials, AiProviderId } from "./types";

export async function callProvider(
  provider: AiProviderId,
  settings: AiGatewaySettings,
  credentials: AiProviderCredentials,
  messages: AiMessage[],
  schema: Record<string, unknown>,
): Promise<{ text: string; model: string }> {
  if (provider === "ollama") {
    if (!settings.ollamaEnabled) throw new Error("Ollama is disabled.");
    const response = await requestUrl({ url: `${settings.ollamaUrl}/api/chat`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: settings.ollamaModel, stream: false, format: schema, messages: collapseSystemMessages(messages, schema), options: { temperature: 0 } }) });
    return { text: String(response.json?.message?.content || "").trim(), model: settings.ollamaModel };
  }
  if (provider === "openai") {
    if (!credentials.openAiApiKey) throw new Error("OpenAI is not configured.");
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const input = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content }));
    const response = await requestUrl({ url: "https://api.openai.com/v1/responses", method: "POST", headers: { Authorization: `Bearer ${credentials.openAiApiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: settings.openAiModel, reasoning: { effort: "medium" }, instructions: system, input, text: { format: { type: "json_schema", name: "tps_gateway_result", strict: true, schema } } }) });
    const text = response.json?.output_text || response.json?.output?.flatMap((entry: any) => entry.content || []).find((entry: any) => entry.type === "output_text")?.text || "";
    return { text: String(text).trim(), model: settings.openAiModel };
  }
  if (!credentials.geminiApiKey) throw new Error("Gemini is not configured.");
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
  const response = await requestUrl({ url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`, method: "POST", headers: { "x-goog-api-key": credentials.geminiApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema } }) });
  const text = response.json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "";
  return { text: String(text).trim(), model: settings.geminiModel };
}

function collapseSystemMessages(messages: AiMessage[], schema: Record<string, unknown>): AiMessage[] {
  const instructions = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const rest = messages.filter((message) => message.role !== "system");
  const grounding = `${instructions}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}`.trim();
  return [{ role: "user", content: grounding }, ...rest];
}
