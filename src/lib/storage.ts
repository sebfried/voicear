import { z } from "zod";
import { agentConnectionSchema, agentTaskSchema, type AgentConnection, type AgentTask } from "./agent-state";
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
const CHAT_STORE = "chats";
const AGENT_CREDENTIAL_STORE = "agentCredentials";
const AGENT_TASK_STORE = "agentTasks";
const SETTINGS_KEY = "voicear.settings";
const ACTIVE_KEY = "voicear.activeChat";
const CREDENTIALS_KEY = "voicear.credentials";
const AGENT_CONNECTIONS_KEY = "voicear.agentConnections";
const DB_CLOSE_KEY = "voicear.dbCloseRequest";
const databaseChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("voicear.database");
let databaseConnection: IDBDatabase | null = null;

const closeDatabaseForUpgrade = () => {
  if (!databaseConnection) return;
  databaseConnection.close();
  databaseConnection = null;
  window.setTimeout(() => location.reload(), 0);
};

databaseChannel?.addEventListener("message", closeDatabaseForUpgrade);
window.addEventListener("storage", (event) => { if (event.key === DB_CLOSE_KEY) closeDatabaseForUpgrade(); });

export type OpenClawIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};

export type HermesCredential = { id: string; kind: "hermes"; apiKey: string; endpointBinding?: string };
export type BoundHermesCredential = HermesCredential & { endpointBinding: string };

export type AgentCredential =
  | HermesCredential
  | { id: string; kind: "openclaw"; endpointBinding?: string; credentialBinding?: string; bootstrapToken?: string; identity?: OpenClawIdentity; deviceTokens?: Record<string, { endpoint: string; token: string; scopes: string[] }> };

export type OpenClawCredential = Extract<AgentCredential, { kind: "openclaw" }>;

const db = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 2);
  request.onupgradeneeded = () => {
    for (const store of [CHAT_STORE, AGENT_CREDENTIAL_STORE, AGENT_TASK_STORE]) {
      if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: "id" });
    }
  };
  request.onsuccess = () => {
    databaseConnection = request.result;
    request.result.onversionchange = closeDatabaseForUpgrade;
    resolve(request.result);
  };
  request.onblocked = () => {
    databaseChannel?.postMessage("close-for-upgrade");
    localStorage.setItem(DB_CLOSE_KEY, crypto.randomUUID());
  };
  request.onerror = () => reject(request.error);
});

const transaction = async <T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const database = await db;
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = run(tx.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const listChats = async () => {
  const raw = await transaction<unknown[]>(CHAT_STORE, "readonly", (store) => store.getAll());
  return raw.flatMap((value) => {
    const parsed = chatSchema.safeParse(value);
    return parsed.success ? [parsed.data as Chat] : [];
  }).sort((a, b) => b.updatedAt - a.updatedAt);
};

export const getChat = async (id: string) => {
  const parsed = chatSchema.safeParse(await transaction<unknown>(CHAT_STORE, "readonly", (store) => store.get(id)));
  return parsed.success ? parsed.data as Chat : null;
};

export const putChat = (chat: Chat) => transaction<IDBValidKey>(CHAT_STORE, "readwrite", (store) => store.put(chat));
export const removeChat = (id: string) => transaction<undefined>(CHAT_STORE, "readwrite", (store) => store.delete(id));

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

export const listAgentConnections = (): AgentConnection[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(AGENT_CONNECTIONS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      const parsed = agentConnectionSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }).sort((left, right) => left.createdAt - right.createdAt);
  } catch {
    return [];
  }
};

export const saveAgentConnection = (connection: AgentConnection) => {
  const parsed = agentConnectionSchema.parse(connection);
  const connections = listAgentConnections().filter(({ id }) => id !== parsed.id).map((saved) =>
    parsed.isDefault ? { ...saved, isDefault: false } : saved
  );
  connections.push(parsed);
  localStorage.setItem(AGENT_CONNECTIONS_KEY, JSON.stringify(connections));
  return parsed;
};

export const getAgentCredential = async (id: string): Promise<AgentCredential | null> => {
  const value = await transaction<unknown>(AGENT_CREDENTIAL_STORE, "readonly", (store) => store.get(id));
  if (!value || typeof value !== "object") return null;
  const credential = value as Partial<AgentCredential>;
  if (credential.id !== id) return null;
  if (credential.kind === "hermes" && typeof credential.apiKey === "string" && credential.apiKey) return credential as AgentCredential;
  if (credential.kind === "openclaw") return credential as AgentCredential;
  return null;
};

export const putAgentCredential = (credential: AgentCredential) =>
  transaction<IDBValidKey>(AGENT_CREDENTIAL_STORE, "readwrite", (store) => store.put(credential));

/** Atomically validates a Hermes key's host binding and upgrades legacy unbound records in place. */
export const bindHermesCredential = async (id: string, endpointBinding: string) => {
  const database = await db;
  return new Promise<BoundHermesCredential | null>((resolve, reject) => {
    const tx = database.transaction(AGENT_CREDENTIAL_STORE, "readwrite");
    const store = tx.objectStore(AGENT_CREDENTIAL_STORE);
    const request = store.get(id);
    let result: BoundHermesCredential | null = null;
    request.onsuccess = () => {
      const current = request.result as Partial<HermesCredential> | undefined;
      if (current?.id !== id || current.kind !== "hermes" || typeof current.apiKey !== "string" || !current.apiKey) return;
      if (current.endpointBinding && current.endpointBinding !== endpointBinding) return;
      result = { ...current, id, kind: "hermes", apiKey: current.apiKey, endpointBinding };
      if (!current.endpointBinding) store.put(result);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const updateOpenClawCredential = async (
  id: string,
  endpointBinding: string,
  credentialBinding: string,
  mutate: (credential: OpenClawCredential) => OpenClawCredential | null
) => {
  const database = await db;
  return new Promise<OpenClawCredential | null>((resolve, reject) => {
    const tx = database.transaction(AGENT_CREDENTIAL_STORE, "readwrite");
    const store = tx.objectStore(AGENT_CREDENTIAL_STORE);
    const request = store.get(id);
    let result: OpenClawCredential | null = null;
    request.onsuccess = () => {
      const current = request.result as Partial<OpenClawCredential> | undefined;
      if (current?.id !== id || current.kind !== "openclaw" || current.endpointBinding !== endpointBinding || current.credentialBinding !== credentialBinding) return;
      try {
        const next = mutate(current as OpenClawCredential);
        if (!next) return;
        result = { ...next, id, kind: "openclaw", endpointBinding, credentialBinding };
        store.put(result);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const bindOpenClawCredential = async (id: string, endpointBinding: string) => {
  const database = await db;
  return new Promise<OpenClawCredential | null>((resolve, reject) => {
    const tx = database.transaction(AGENT_CREDENTIAL_STORE, "readwrite");
    const store = tx.objectStore(AGENT_CREDENTIAL_STORE);
    const request = store.get(id);
    let result: OpenClawCredential | null = null;
    request.onsuccess = () => {
      const current = request.result as Partial<OpenClawCredential> | undefined;
      if (current?.id !== id || current.kind !== "openclaw") return;
      if (current.endpointBinding === endpointBinding && current.credentialBinding) {
        result = current as OpenClawCredential;
        return;
      }
      if (current.endpointBinding && current.endpointBinding !== endpointBinding) return;
      result = {
        ...(current as OpenClawCredential),
        endpointBinding,
        credentialBinding: crypto.randomUUID(),
        deviceTokens: undefined,
      };
      store.put(result);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const listAgentTasks = async () => {
  const raw = await transaction<unknown[]>(AGENT_TASK_STORE, "readonly", (store) => store.getAll());
  return raw.flatMap((value) => {
    const parsed = agentTaskSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
};

export const getAgentTask = async (id: string) => {
  const parsed = agentTaskSchema.safeParse(await transaction<unknown>(AGENT_TASK_STORE, "readonly", (store) => store.get(id)));
  return parsed.success ? parsed.data : null;
};

export const putAgentTask = (task: AgentTask) =>
  transaction<IDBValidKey>(AGENT_TASK_STORE, "readwrite", (store) => store.put(agentTaskSchema.parse(task)));

export const removeAgentConnection = async (id: string) => {
  const database = await db;
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction([AGENT_CREDENTIAL_STORE, AGENT_TASK_STORE], "readwrite");
    tx.objectStore(AGENT_CREDENTIAL_STORE).delete(id);
    const cursor = tx.objectStore(AGENT_TASK_STORE).openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      const task = agentTaskSchema.safeParse(current.value);
      if (task.success && task.data.connectionId === id) current.delete();
      current.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  localStorage.setItem(AGENT_CONNECTIONS_KEY, JSON.stringify(listAgentConnections().filter((connection) => connection.id !== id)));
};
