import { z } from "zod";
import type { Chat } from "./state";

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: z.enum(["in_progress", "completed", "incomplete"])
});

const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(messageSchema)
});

const settingsSchema = z.object({
  fontScale: z.number().min(0.8).max(1.8),
  model: z.enum(["gpt-realtime-2.1-mini", "gpt-realtime-2.1"])
});

export const credentialsSchema = z.object({
  openai: z.string().min(20, "OpenAI-Schlüssel fehlt.")
});

export type Settings = z.infer<typeof settingsSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

const DB_NAME = "voicear";
const STORE = "chats";
const SETTINGS_KEY = "voicear.settings";
const ACTIVE_KEY = "voicear.activeChat";
const CREDENTIALS_KEY = "voicear.credentials";

const db = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const database = await db;
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const listChats = async () => {
  const raw = await transaction<unknown[]>("readonly", (store) => store.getAll());
  return raw.flatMap((value) => {
    const parsed = chatSchema.safeParse(value);
    return parsed.success ? [parsed.data as Chat] : [];
  }).sort((a, b) => b.updatedAt - a.updatedAt);
};

export const getChat = async (id: string) => {
  const parsed = chatSchema.safeParse(await transaction<unknown>("readonly", (store) => store.get(id)));
  return parsed.success ? parsed.data as Chat : null;
};

export const putChat = (chat: Chat) => transaction<IDBValidKey>("readwrite", (store) => store.put(chat));
export const removeChat = (id: string) => transaction<undefined>("readwrite", (store) => store.delete(id));

export const loadSettings = (): Settings => {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch {}
  return { fontScale: 1, model: "gpt-realtime-2.1-mini" };
};

export const saveSettings = (settings: Settings) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
export const loadActiveChatId = () => localStorage.getItem(ACTIVE_KEY);
export const saveActiveChatId = (id: string) => localStorage.setItem(ACTIVE_KEY, id);

export const loadCredentials = (): Credentials | null => {
  try {
    const saved = localStorage.getItem(CREDENTIALS_KEY) ?? sessionStorage.getItem(CREDENTIALS_KEY);
    const parsed = credentialsSchema.safeParse(JSON.parse(saved ?? "null"));
    if (!parsed.success) return null;
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(parsed.data));
    sessionStorage.removeItem(CREDENTIALS_KEY);
    return parsed.data;
  } catch {
    return null;
  }
};

export const saveCredentials = (credentials: Credentials) => {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  sessionStorage.removeItem(CREDENTIALS_KEY);
};
export const clearCredentials = () => {
  localStorage.removeItem(CREDENTIALS_KEY);
  sessionStorage.removeItem(CREDENTIALS_KEY);
};
