import type { RealtimeItem, RealtimeSession as RealtimeSessionInstance } from "@openai/agents/realtime";
import { z } from "zod";
import { chatTitle, findChats, historyToMessages, messagesToHistory, newChat, type Chat } from "../lib/state";
import { clearCredentials, credentialsSchema, getChat, listChats, loadActiveChatId, loadCredentials, loadSettings, putChat, removeChat, saveActiveChatId, saveCredentials, saveSettings, type Credentials } from "../lib/storage";
import { WakeWordDetector } from "../lib/wake-word";

type AgentsModule = typeof import("@openai/agents/realtime");

let RealtimeAgent: AgentsModule["RealtimeAgent"];
let RealtimeSession: AgentsModule["RealtimeSession"];
let OpenAIRealtimeWebRTC: AgentsModule["OpenAIRealtimeWebRTC"];
let tool: AgentsModule["tool"];

let agentsLibrary: Promise<void> | null = null;
const loadAgentsLibrary = () => agentsLibrary ??= import("@openai/agents/realtime").then((module) => {
  RealtimeAgent = module.RealtimeAgent;
  RealtimeSession = module.RealtimeSession;
  OpenAIRealtimeWebRTC = module.OpenAIRealtimeWebRTC;
  tool = module.tool;
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dateElement = $<HTMLTimeElement>("date");
const clockElement = $<HTMLTimeElement>("clock");
const statusElement = $("status");
const transcriptElement = $("transcript");
const currentButton = $<HTMLButtonElement>("current");
const startScreen = $("start-screen");
const startButton = $<HTMLButtonElement>("start");
const noticeElement = $("notice");
const sidebar = $("sidebar");
const chatsButton = $<HTMLButtonElement>("chats-button");
const chatList = $<HTMLOListElement>("chat-list");
const fullscreenButton = $<HTMLButtonElement>("fullscreen");
const settingsDialog = $<HTMLDialogElement>("settings-dialog");
const settingsForm = $<HTMLFormElement>("settings-form");
const settingsError = $("settings-error");
const openaiInput = $<HTMLInputElement>("openai-key");
const modelSelect = $<HTMLSelectElement>("model");
const saveSettingsButton = $<HTMLButtonElement>("save-settings");
const audioElement = $<HTMLAudioElement>("agent-audio");

let credentialImportError = "";
const importCredentialsFromUrl = () => {
  const url = new URL(location.href);
  const key = url.searchParams.get("key");
  if (key === null) return null;
  url.searchParams.delete("key");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const parsed = credentialsSchema.safeParse({ openai: key.trim() });
  if (!parsed.success) {
    credentialImportError = parsed.error.issues[0]?.message ?? "Ungültiger OpenAI-Schlüssel in der URL.";
    return null;
  }
  saveCredentials(parsed.data);
  return parsed.data;
};

let settings = loadSettings();
let credentials = importCredentialsFromUrl() ?? loadCredentials();
let activeChat: Chat;
let session: RealtimeSessionInstance | null = null;
let mediaStream: MediaStream | null = null;
let wakeDetector: WakeWordDetector | null = null;
let wakeSubscribed = false;
let wakeLock: WakeLockSentinel | null = null;
let started = false;
let autoFollow = true;
let freshChatOnWake = false;
let idleTimer = 0;
let flushHistory: (() => Promise<void>) | null = null;
let reconnectingAudio = false;
let realtimeStarting = false;
let wakeStarting = false;
const renderedText = new WeakMap<HTMLElement, string>();

const setStatus = (value: "STARTING" | "READY" | "CONNECTING" | "LISTENING" | "THINKING" | "SPEAKING" | "PAUSED" | "OFFLINE" | "ERROR") => {
  statusElement.textContent = `VOICE: ${value}`;
  document.body.dataset.status = value;
};

const setNotice = (message = "") => { noticeElement.textContent = message; };

const errorMessage = (value: unknown, fallback: string) => {
  const seen = new Set<object>();
  const read = (candidate: unknown): string => {
    if (candidate instanceof Error) return candidate.message;
    if (typeof candidate === "string") return candidate === "[object Object]" ? "" : candidate;
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return "";
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const message = [record.message, record.error, record.reason, record.detail, record.cause].map(read).find(Boolean) ?? "";
    const code = typeof record.code === "string" ? record.code : "";
    return message && code && !message.includes(code) ? `${message} (${code})` : message || code;
  };
  return read(value) || fallback;
};

const updateClock = () => {
  const now = new Date();
  dateElement.dateTime = now.toISOString();
  clockElement.dateTime = now.toISOString();
  dateElement.textContent = new Intl.DateTimeFormat("de-AT", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(now).toLocaleUpperCase("de");
  clockElement.textContent = new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit" }).format(now);
};

const setFontScale = (fontScale: number) => {
  settings.fontScale = Math.min(1.8, Math.max(.8, Math.round(fontScale * 10) / 10));
  document.documentElement.style.setProperty("--font-scale", String(settings.fontScale));
  saveSettings(settings);
  return `${Math.round(settings.fontScale * 100)} Prozent`;
};

const renderTranscript = (messages = activeChat.messages, revealNewText = false) => {
  const visibleMessages = messages.slice(-100);
  const animatedMessageId = revealNewText ? visibleMessages.at(-1)?.id : undefined;
  const visibleIds = new Set(visibleMessages.map(({ id }) => id));
  const articles = new Map([...transcriptElement.children].map((element) => [(element as HTMLElement).dataset.messageId, element as HTMLElement]));
  for (const [id, article] of articles) if (!id || !visibleIds.has(id)) article.remove();

  for (const message of visibleMessages) {
    let article = articles.get(message.id);
    if (!article) {
      article = document.createElement("article");
      article.dataset.messageId = message.id;
      const speaker = document.createElement("span");
      speaker.className = "speaker";
      speaker.textContent = message.role === "user" ? "YOU" : "VOICE";
      article.append(speaker, document.createElement("p"));
      transcriptElement.append(article);
    }
    article.className = `message ${message.status}`;
    const text = article.querySelector("p")!;
    const previousText = renderedText.get(text) ?? "";
    const nextText = message.text;
    if (message.id !== animatedMessageId) {
      text.classList.remove("message-fade");
      for (const fragment of text.querySelectorAll<HTMLElement>(".word-reveal")) {
        fragment.classList.remove("word-reveal");
        fragment.style.removeProperty("--reveal-index");
      }
    }
    if (!nextText.startsWith(previousText)) text.replaceChildren();
    const addition = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
    let revealIndex = 0;
    for (const part of addition.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        text.append(part);
      } else {
        const fragment = document.createElement("span");
        fragment.textContent = part;
        if (message.id === animatedMessageId && message.role === "assistant") {
          fragment.className = "word-reveal";
          fragment.style.setProperty("--reveal-index", String(revealIndex++));
          fragment.addEventListener("animationend", () => {
            fragment.classList.remove("word-reveal");
            fragment.style.removeProperty("--reveal-index");
          }, { once: true });
        }
        text.append(fragment);
      }
    }
    if (message.id === animatedMessageId && message.role === "user" && !previousText && nextText) {
      text.classList.add("message-fade");
      text.addEventListener("animationend", () => text.classList.remove("message-fade"), { once: true });
    }
    renderedText.set(text, nextText);
  }
  if (autoFollow) requestAnimationFrame(() => { transcriptElement.scrollTop = transcriptElement.scrollHeight; });
};

const showCurrent = () => {
  autoFollow = true;
  currentButton.classList.add("hidden");
  transcriptElement.scrollTop = transcriptElement.scrollHeight;
};

const openSidebar = async () => {
  await renderChatList();
  sidebar.classList.add("open");
  sidebar.setAttribute("aria-hidden", "false");
  chatsButton.setAttribute("aria-expanded", "true");
};

const closeSidebar = () => {
  sidebar.classList.remove("open");
  sidebar.setAttribute("aria-hidden", "true");
  chatsButton.setAttribute("aria-expanded", "false");
};

const renderChatList = async () => {
  const chats = await listChats();
  const fragment = document.createDocumentFragment();
  for (const chat of chats) {
    const item = document.createElement("li");
    const select = document.createElement("button");
    select.type = "button";
    select.className = "chat-select";
    select.dataset.chatId = chat.id;
    select.setAttribute("aria-current", String(chat.id === activeChat.id));
    const title = document.createElement("span");
    title.textContent = chat.title;
    const meta = document.createElement("span");
    meta.className = "chat-meta";
    meta.textContent = new Intl.DateTimeFormat("de-AT", { dateStyle: "short", timeStyle: "short" }).format(chat.updatedAt);
    select.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-chat";
    remove.dataset.deleteChat = chat.id;
    remove.setAttribute("aria-label", `${chat.title} löschen`);
    remove.textContent = "[ × ]";
    item.append(select, remove);
    fragment.append(item);
  }
  chatList.replaceChildren(fragment);
};

const acquireWakeLock = async () => {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
};

const updateFullscreenButton = () => {
  const installedFullscreen = matchMedia("(display-mode: fullscreen)").matches;
  fullscreenButton.classList.toggle("hidden", Boolean(document.fullscreenElement) || installedFullscreen || !document.fullscreenEnabled);
};

const releaseWakeWorker = async () => {
  if (wakeDetector) await wakeDetector.destroy();
  wakeSubscribed = false;
  wakeDetector = null;
};

const prepareWakeWorker = async () => {
  if (wakeDetector) return;
  await serviceWorkerReady;
  const detector = new WakeWordDetector(
    (score) => { console.info("Hey Jarvis erkannt", { score }); void onWakeWord(); },
    (error) => {
      wakeSubscribed = false;
      void detector.stop();
      console.error("Wake word", error);
      setStatus("ERROR");
      setNotice(error.message);
    }
  );
  wakeDetector = detector;
  try {
    await detector.load();
  } catch (error) {
    if (wakeDetector === detector) wakeDetector = null;
    await detector.destroy();
    throw error;
  }
};

const stopWake = async () => {
  if (!wakeDetector || !wakeSubscribed) return;
  wakeSubscribed = false;
  await wakeDetector.stop();
};

const startWake = async (readyStatus: "READY" | "PAUSED" = "READY") => {
  if (!started) return;
  if (!credentials) { openSettings(); return; }
  if (wakeStarting) return;
  wakeStarting = true;
  setStatus("STARTING");
  try {
    await prepareWakeWorker();
    if (!wakeSubscribed) {
      await wakeDetector!.start();
      wakeSubscribed = true;
    }
    setStatus(navigator.onLine ? readyStatus : "OFFLINE");
  } catch (error) {
    setStatus("ERROR");
    setNotice(errorMessage(error, "Wake Word konnte nicht gestartet werden."));
  } finally {
    wakeStarting = false;
  }
};

const resetIdleTimer = () => {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => { if (session) void pauseVoice(); }, 60_000);
};

const agentTools = () => [
  tool({
    name: "new_chat",
    description: "Start a new local chat immediately when the user asks for a new conversation.",
    parameters: z.object({}),
    execute: async () => {
      window.setTimeout(() => { void createAndSelectChat(true); }, 350);
      return "A new chat is starting now.";
    }
  }),
  tool({
    name: "switch_chat",
    description: "Switch directly to an existing local chat. Use a distinctive word from the title.",
    parameters: z.object({ query: z.string().min(1) }),
    execute: async ({ query }) => {
      const matches = findChats(await listChats(), query);
      if (matches.length === 0) return `No chat title matches ${query}.`;
      if (matches.length > 1) return `Several chats match: ${matches.slice(0, 5).map(({ title }) => title).join(", ")}. Ask which one.`;
      window.setTimeout(() => { void selectChat(matches[0].id, true); }, 350);
      return `Switching to ${matches[0].title}.`;
    }
  }),
  tool({
    name: "list_chats",
    description: "List recent local chat titles so the user can choose one by voice.",
    parameters: z.object({}),
    execute: async () => (await listChats()).slice(0, 12).map(({ title }) => title).join(", ") || "There are no saved chats."
  }),
  tool({
    name: "show_chats",
    description: "Open the local chat-history sidebar.",
    parameters: z.object({}),
    execute: async () => { await openSidebar(); return "Chat history is open."; }
  }),
  tool({
    name: "set_font_size",
    description: "Change the visible transcript font. For relative requests use larger/smaller/reset. For an exact request set percent and use action reset.",
    parameters: z.object({ action: z.enum(["larger", "smaller", "reset"]), percent: z.number().min(80).max(180).nullable() }),
    execute: async ({ action, percent }) => {
      const next = percent ? percent / 100 : action === "larger" ? settings.fontScale + .1 : action === "smaller" ? settings.fontScale - .1 : 1;
      return `Font size is now ${setFontScale(next)}.`;
    }
  }),
  tool({
    name: "current_voice",
    description: "Return the transcript to the current message after the user browsed older content.",
    parameters: z.object({}),
    execute: async () => { showCurrent(); return "Showing the current message."; }
  }),
  tool({
    name: "pause_voice",
    description: "Pause the cloud voice session and return to local wake-word listening.",
    parameters: z.object({}),
    execute: async () => { window.setTimeout(() => { void pauseVoice(); }, 350); return "Voice is pausing."; }
  }),
  tool({
    name: "stop_voice",
    description: "Stop this cloud voice session. The next wake word starts a new chat.",
    parameters: z.object({}),
    execute: async () => { window.setTimeout(() => { void stopVoice(); }, 350); return "Voice is stopping."; }
  })
];

const startRealtime = async () => {
  if (realtimeStarting || session) return;
  if (!credentials) { openSettings(); return; }
  if (!navigator.onLine) { setStatus("OFFLINE"); await startWake(); return; }
  realtimeStarting = true;
  await stopWake();
  setNotice();
  setStatus("CONNECTING");
  let chat = await getChat(activeChat.id) ?? activeChat;
  let latestMessages = chat.messages;
  let persistTimer = 0;
  let hydrating = true;

  try {
    await loadAgentsLibrary();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const track = mediaStream.getAudioTracks()[0];
    track.enabled = false;
    console.info("Active microphone settings", track.getSettings());

    const transport = new OpenAIRealtimeWebRTC({
      audioElement,
      mediaStream,
      baseUrl: `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(settings.model)}`,
      useInsecureApiKey: !credentials.openai.startsWith("ek_")
    });
    const agent = new RealtimeAgent({
      name: "Voice",
      instructions: "You are Voice, a concise hands-free assistant. Reply in the user's language. Prefer one or two calm sentences unless detail is requested. Use the local tools whenever the user asks to create or switch chats, list or show chats, change font size, return to the current transcript, pause, or stop. Never claim a local UI action happened without calling its tool.",
      tools: agentTools()
    });
    const nextSession = new RealtimeSession(agent, {
      model: settings.model,
      transport,
      historyStoreAudio: false,
      tracingDisabled: true,
      config: {
        outputModalities: ["audio"],
        audio: {
          input: {
            noiseReduction: { type: "near_field" },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turnDetection: { type: "semantic_vad", eagerness: "auto", createResponse: true, interruptResponse: true }
          },
          output: { voice: "marin", speed: 1 }
        }
      }
    });
    session = nextSession;
    flushHistory = async () => {
      window.clearTimeout(persistTimer);
      chat.messages = latestMessages;
      chat.updatedAt = Date.now();
      const firstUser = chat.messages.find(({ role, text }) => role === "user" && text.trim());
      if (firstUser && chat.title === "NEUER CHAT") chat.title = chatTitle(firstUser.text);
      await putChat(chat);
      if (activeChat.id === chat.id) activeChat = chat;
    };

    nextSession.on("history_updated", (history: RealtimeItem[]) => {
      if (hydrating) return;
      latestMessages = historyToMessages(history);
      if (activeChat.id === chat.id) renderTranscript(latestMessages, true);
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => { void flushHistory?.(); }, 250);
      resetIdleTimer();
    });
    nextSession.on("agent_start", () => { setStatus("THINKING"); resetIdleTimer(); });
    nextSession.on("audio_start", () => { setStatus("SPEAKING"); resetIdleTimer(); });
    nextSession.on("audio_stopped", () => { if (session === nextSession) setStatus("LISTENING"); resetIdleTimer(); });
    nextSession.on("audio_interrupted", () => { if (session === nextSession) setStatus("LISTENING"); });
    nextSession.on("error", ({ error }) => {
      console.error("Realtime session", error);
      if (session !== nextSession) return;
      setStatus("ERROR");
      setNotice(`REALTIME FEHLER: ${errorMessage(error, "WebRTC-Verbindung unterbrochen.")}`);
      if (!hydrating) void endRealtime("READY");
    });

    await nextSession.connect({ apiKey: credentials.openai, model: settings.model });
    if (chat.messages.length) nextSession.updateHistory(messagesToHistory(chat.messages));
    hydrating = false;
    track.enabled = true;
    setStatus("LISTENING");
    resetIdleTimer();
  } catch (error) {
    console.error("Realtime start", error);
    if (session) session.close();
    session = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    setStatus("ERROR");
    setNotice(`REALTIME FEHLER: ${errorMessage(error, "Verbindung fehlgeschlagen. Prüfe API-Key, Billing und Modellzugriff.")}`);
    await startWake();
  } finally {
    realtimeStarting = false;
  }
};

const endRealtime = async (resumeWake: false | "READY" | "PAUSED" = false) => {
  window.clearTimeout(idleTimer);
  const closing = session;
  session = null;
  closing?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  await flushHistory?.();
  flushHistory = null;
  if (resumeWake) await startWake(resumeWake);
};

async function pauseVoice() {
  await endRealtime("PAUSED");
}

async function stopVoice() {
  freshChatOnWake = true;
  await endRealtime("READY");
}

async function onWakeWord() {
  await stopWake();
  if (freshChatOnWake) {
    freshChatOnWake = false;
    activeChat = newChat();
    await putChat(activeChat);
    saveActiveChatId(activeChat.id);
    renderTranscript();
  }
  await startRealtime();
}

const selectChat = async (id: string, keepVoice = false) => {
  const wasActive = Boolean(session) && keepVoice;
  await endRealtime(false);
  const chat = await getChat(id);
  if (!chat) return;
  activeChat = chat;
  saveActiveChatId(chat.id);
  renderTranscript();
  closeSidebar();
  if (wasActive) await startRealtime();
  else if (started && !wakeSubscribed) await startWake();
};

const createAndSelectChat = async (keepVoice: boolean) => {
  const chat = newChat();
  await putChat(chat);
  await selectChat(chat.id, keepVoice);
};

const openSettings = () => {
  const saved = loadCredentials();
  openaiInput.value = saved?.openai ?? "";
  modelSelect.value = settings.model;
  settingsError.textContent = "";
  if (!settingsDialog.open) settingsDialog.showModal();
};

const exportHistory = async () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), chats: await listChats() }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `voice-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
};

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const parsed = credentialsSchema.safeParse({ openai: openaiInput.value.trim() });
  if (!parsed.success) { settingsError.textContent = parsed.error.issues[0]?.message ?? "Ungültige Schlüssel."; return; }
  saveSettingsButton.disabled = true;
  settingsError.textContent = "HEY JARVIS WIRD LOKAL VORBEREITET…";
  credentials = parsed.data as Credentials;
  settings.model = modelSelect.value as typeof settings.model;
  saveCredentials(credentials);
  saveSettings(settings);
  try {
    await prepareWakeWorker();
    settingsDialog.close();
    setNotice();
    startButton.textContent = "[ START VOICE ]";
  } catch (error) {
    settingsError.textContent = errorMessage(error, "Hey Jarvis konnte nicht vorbereitet werden.");
  } finally {
    saveSettingsButton.disabled = false;
  }
});

startButton.addEventListener("click", async () => {
  if (!credentials) { openSettings(); return; }
  started = true;
  document.documentElement.requestFullscreen?.().catch(() => {});
  void navigator.storage?.persist?.();
  startScreen.classList.add("started");
  await startWake();
  await acquireWakeLock();
});

chatsButton.addEventListener("click", () => { sidebar.classList.contains("open") ? closeSidebar() : void openSidebar(); });
$("close-sidebar").addEventListener("click", closeSidebar);
$("new-chat").addEventListener("click", () => { void createAndSelectChat(Boolean(session)); });
$("settings-button").addEventListener("click", () => { closeSidebar(); void endRealtime(false).then(openSettings); });
$("export-button").addEventListener("click", () => { void exportHistory(); });
$("cancel-settings").addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("close", () => { if (started && !session && !wakeSubscribed) void startWake(); });
$("clear-keys").addEventListener("click", async () => {
  await endRealtime(false);
  clearCredentials();
  credentials = null;
  started = false;
  startScreen.classList.remove("started");
  startButton.textContent = "[ CONFIGURE KEYS ]";
  openaiInput.value = "";
  await releaseWakeWorker();
  setStatus(navigator.onLine ? "READY" : "OFFLINE");
  settingsError.textContent = "SCHLÜSSEL FÜR DIESEN TAB GELÖSCHT.";
});
currentButton.addEventListener("click", showCurrent);
fullscreenButton.addEventListener("click", () => { void document.documentElement.requestFullscreen?.(); });

chatList.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const select = target.closest<HTMLButtonElement>("[data-chat-id]");
  if (select?.dataset.chatId) { await selectChat(select.dataset.chatId, Boolean(session)); return; }
  const remove = target.closest<HTMLButtonElement>("[data-delete-chat]");
  const id = remove?.dataset.deleteChat;
  if (!id) return;
  const chat = await getChat(id);
  if (!chat || !confirm(`„${chat.title}“ lokal löschen?`)) return;
  await removeChat(id);
  if (id === activeChat.id) {
    const remaining = await listChats();
    if (remaining[0]) await selectChat(remaining[0].id, Boolean(session));
    else await createAndSelectChat(Boolean(session));
  }
  await renderChatList();
});

transcriptElement.addEventListener("scroll", () => {
  autoFollow = transcriptElement.scrollHeight - transcriptElement.clientHeight - transcriptElement.scrollTop < 48;
  currentButton.classList.toggle("hidden", autoFollow);
}, { passive: true });

document.addEventListener("fullscreenchange", updateFullscreenButton);
const restoreWakeAudio = async () => {
  if (!started || !wakeSubscribed || !wakeDetector) return;
  try {
    await wakeDetector.resume();
  } catch {
    await stopWake();
    await startWake();
  }
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (started) void acquireWakeLock();
  void restoreWakeAudio();
});
window.addEventListener("pageshow", () => { void restoreWakeAudio(); });
window.addEventListener("offline", () => { setStatus("OFFLINE"); if (session) void endRealtime("READY"); });
window.addEventListener("online", () => { if (started && !session) void startWake(); });
navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (!started || reconnectingAudio || wakeStarting || realtimeStarting) return;
  reconnectingAudio = true;
  window.setTimeout(async () => {
    const wasActive = Boolean(session);
    if (wasActive) { await endRealtime(false); await startRealtime(); }
    else { await stopWake(); await startWake(); }
    reconnectingAudio = false;
  }, 500);
});

const initialize = async () => {
  updateClock();
  window.setInterval(updateClock, 15_000);
  setFontScale(settings.fontScale);
  const chats = await listChats();
  const preferred = loadActiveChatId();
  activeChat = chats.find(({ id }) => id === preferred) ?? chats[0] ?? newChat();
  if (!chats.some(({ id }) => id === activeChat.id)) await putChat(activeChat);
  saveActiveChatId(activeChat.id);
  renderTranscript();
  updateFullscreenButton();
  setStatus(navigator.onLine ? "READY" : "OFFLINE");
  if (!credentials) {
    startButton.textContent = "[ CONFIGURE KEYS ]";
    openSettings();
    if (credentialImportError) settingsError.textContent = credentialImportError;
  } else {
    void prepareWakeWorker().catch((error) => setNotice(errorMessage(error, "Wake Word nicht vorbereitet.")));
  }
};

const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<void>((resolve) => window.setTimeout(resolve, 5_000))
    ]);
  } catch (error) {
    console.warn("Offline-Cache", error);
  }
};

const serviceWorkerReady = registerServiceWorker();
void initialize();
