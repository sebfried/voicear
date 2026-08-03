import type { RealtimeItem, RealtimeMessageItem } from "@openai/agents/realtime";
import type { Message } from "./state";

export const historyToMessages = (history: RealtimeItem[]): Message[] =>
  history.flatMap((item) => {
    if (item.type !== "message" || item.role === "system") return [];
    const text = item.content.map((part) => "text" in part ? part.text : part.transcript ?? "").join("").trim();
    if (!text) return [];
    return [{ id: item.itemId, role: item.role, text, status: item.status }];
  });

export const withoutHistoryItems = (history: RealtimeItem[], hiddenItemIds: ReadonlySet<string>): RealtimeItem[] =>
  history.filter(({ itemId }) => !hiddenItemIds.has(itemId));

export const messagesToHistory = (messages: Message[]): RealtimeMessageItem[] => {
  let previousItemId: string | null = null;
  const usedIds = new Set<string>();
  return messages.filter(({ text }) => text.trim()).map((message) => {
    const candidate = message.id.replaceAll("-", "");
    const itemId = /^[A-Za-z0-9_]{1,32}$/.test(candidate) && !usedIds.has(candidate)
      ? candidate
      : crypto.randomUUID().replaceAll("-", "");
    usedIds.add(itemId);
    const base = { itemId, previousItemId, type: "message" as const };
    previousItemId = itemId;
    if (message.role === "user") {
      return { ...base, role: "user" as const, status: "completed" as const, content: [{ type: "input_text" as const, text: message.text }] };
    }
    return { ...base, role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text: message.text }] };
  });
};
