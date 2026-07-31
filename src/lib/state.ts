import type { RealtimeItem } from "@openai/agents/realtime";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "in_progress" | "completed" | "incomplete";
};

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
};

export const newChat = (): Chat => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "NEUER CHAT",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
};

export const normalizeCommand = (value: string) =>
  value.toLocaleLowerCase("de").replace(/[.,!?;:]/g, "").replace(/\s+/g, " ").trim();

export const chatTitle = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 44) return clean.toLocaleUpperCase("de");
  const cut = clean.slice(0, 45).replace(/\s+\S*$/, "");
  return `${cut || clean.slice(0, 44)}…`.toLocaleUpperCase("de");
};

export const findChats = (chats: Chat[], query: string) => {
  const needle = normalizeCommand(query);
  const ranked = chats.map((chat) => {
    const title = normalizeCommand(chat.title);
    const rank = title === needle ? 0 : title.startsWith(needle) ? 1 : title.includes(needle) ? 2 : 3;
    return { chat, rank };
  });
  return ranked.filter(({ rank }) => rank < 3).sort((a, b) => a.rank - b.rank || b.chat.updatedAt - a.chat.updatedAt).map(({ chat }) => chat);
};

export const historyToMessages = (history: RealtimeItem[]): Message[] =>
  history.flatMap((item) => {
    if (item.type !== "message" || item.role === "system") return [];
    const text = item.content.map((part) => "text" in part ? part.text : part.transcript ?? "").join("").trim();
    if (!text) return [];
    return [{ id: item.itemId, role: item.role, text, status: item.status }];
  });

export const messagesToHistory = (messages: Message[]): RealtimeItem[] => {
  let previousItemId: string | null = null;
  return messages.filter(({ text }) => text.trim()).map((message) => {
    const itemId = crypto.randomUUID().replaceAll("-", "");
    const base = { itemId, previousItemId, type: "message" as const };
    previousItemId = itemId;
    if (message.role === "user") {
      return { ...base, role: "user" as const, status: "completed" as const, content: [{ type: "input_text" as const, text: message.text }] };
    }
    return { ...base, role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text: message.text }] };
  });
};
