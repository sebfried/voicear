import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  formatConnectErrorMessage,
  readPairingConnectErrorDetails,
  readSessionMessageIdentity,
  readSessionMessageSequence,
  shouldPauseGatewayReconnect,
  type ConnectParams,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceIdentity,
  type GatewayBrowserDeviceTokenStore,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
  type HelloOk
} from "@openclaw/gateway-client/browser";

const PROTOCOL_VERSION = 4;
const OPERATOR_SCOPES = ["operator.read", "operator.write"] as const;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MUTATION_RECONCILE_DELAY_MS = 500;
const HISTORY_LIMIT = 100;
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_PROGRESS_CHARS = 32 * 1024;
const MAX_ERROR_CHARS = 4 * 1024;
const MAX_GATEWAY_FRAME_CHARS = 1024 * 1024;
const TRUNCATED = "\n[truncated by Voicear]";

export type OpenClawCredentialStore = {
  loadOrCreateIdentity: () => Promise<GatewayBrowserDeviceIdentity>;
  /** Scope this store to one configured connection/endpoint in the host. */
  tokenStore: GatewayBrowserDeviceTokenStore;
};

export type OpenClawConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "pairing_required"
  | "error"
  | "stopped";

export type OpenClawStatus = OpenClawConnectionState;

export type OpenClawStatusDetail = {
  error?: Error;
  requestId?: string;
};

export type OpenClawHello = {
  protocol: number;
  serverVersion?: string;
  connectionId?: string;
};

export type OpenClawTaskRef = {
  taskId: string;
  sessionKey: string;
  runId?: string;
};

type OpenClawTaskIdentity = {
  taskId: string;
  sessionKey: string;
  runId?: string;
  sequence?: number;
  remoteSessionId?: string;
  remoteRunId?: string;
};

type OpenClawTaskEventBase = OpenClawTaskIdentity & {
  source: "live" | "reconcile";
};

export type OpenClawTaskEvent =
  | (OpenClawTaskEventBase & { type: "accepted" })
  | (OpenClawTaskEventBase & { type: "progress"; text: string; sequence?: number })
  | (OpenClawTaskEventBase & { type: "completed"; text: string; result: string })
  | (OpenClawTaskEventBase & { type: "failed"; text: string; code: string; message: string })
  | (OpenClawTaskEventBase & { type: "canceled" });

export type OpenClawReconciliation = OpenClawTaskIdentity & {
  status: "running" | "completed" | "failed" | "canceled" | "unknown";
  sequence?: number;
  progress?: string;
  result?: string;
  error?: { code: string; message: string };
};

export type OpenClawStartOptions = {
  endpoint: string;
  /** Optional OpenClaw agentId. */
  target?: string;
  /** One-time bootstrap credential; this module never persists it. */
  bootstrapToken?: string;
  credentialStore: OpenClawCredentialStore;
  onStatus?: (status: OpenClawStatus, detail?: OpenClawStatusDetail) => void;
  onTaskEvent?: (event: OpenClawTaskEvent) => void;
};

export class OpenClawConnectorError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code = "OPENCLAW_ERROR",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "OpenClawConnectorError";
    this.code = code;
  }
}

export class OpenClawPairingRequiredError extends OpenClawConnectorError {
  readonly requestId?: string;
  readonly reason?: string;

  constructor(
    message: string,
    requestId?: string,
    reason?: string,
    options?: ErrorOptions
  ) {
    super(message, "PAIRING_REQUIRED", options);
    this.name = "OpenClawPairingRequiredError";
    this.requestId = requestId;
    this.reason = reason;
  }
}

export class OpenClawSubmissionError extends OpenClawConnectorError {
  readonly ambiguous: boolean;

  constructor(message: string, ambiguous: boolean, options?: ErrorOptions) {
    super(message, ambiguous ? "SUBMISSION_UNKNOWN" : "SUBMISSION_REJECTED", options);
    this.name = "OpenClawSubmissionError";
    this.ambiguous = ambiguous;
  }
}

type ConnectPlan = {
  generation: number;
  auth: GatewayBrowserDeviceAuthPlan;
};

type Waiter = {
  resolve: (hello: OpenClawHello) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ChatHistory = {
  messages?: unknown[];
  sessionId?: unknown;
  inFlightRun?: { runId?: unknown; text?: unknown };
  sessionInfo?: {
    sessionId?: unknown;
    status?: unknown;
    lastRunError?: unknown;
    activeRunIds?: unknown;
  };
};

type ChatPayload = {
  state: "status" | "delta" | "final" | "aborted" | "error";
  sessionKey: string;
  runId: string;
  agentId?: string;
  seq?: number;
  phase?: string;
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  errorKind?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonempty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const remoteId = (value: unknown, maximum = 512) => {
  const id = nonempty(value);
  return id && id.length <= maximum ? id : undefined;
};

const bounded = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - TRUNCATED.length))}${TRUNCATED}`;

const connectorError = (error: unknown, code = "OPENCLAW_ERROR") =>
  error instanceof OpenClawConnectorError
    ? error
    : new OpenClawConnectorError(
        error instanceof Error ? error.message : String(error),
        code,
        { cause: error }
      );

const hasExactOperatorScopes = (scopes: readonly string[]) =>
  scopes.length === OPERATOR_SCOPES.length && OPERATOR_SCOPES.every((scope) => scopes.includes(scope));

const isLoopbackHost = (hostname: string) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host);
};

/** Enforces encrypted remote transport; plaintext is accepted only on loopback. */
export const normalizeOpenClawEndpoint = (endpoint: string) => {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch (error) {
    throw new OpenClawConnectorError("Invalid OpenClaw WebSocket endpoint.", "INVALID_ENDPOINT", { cause: error });
  }
  if (url.username || url.password || url.hash) {
    throw new OpenClawConnectorError(
      "OpenClaw endpoint URLs must not contain credentials or fragments.",
      "INVALID_ENDPOINT"
    );
  }
  if (url.search) {
    throw new OpenClawConnectorError(
      "OpenClaw endpoint URLs must not contain query parameters.",
      "INVALID_ENDPOINT"
    );
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) {
    throw new OpenClawConnectorError(
      "OpenClaw requires wss://; ws:// is allowed only for localhost or loopback IPs.",
      "INSECURE_ENDPOINT"
    );
  }
  return url.toString();
};

const createBrowserSocket = (
  endpoint: string,
  handlers: GatewayProtocolSocketHandlers
): GatewayProtocolSocket => {
  const socket = new WebSocket(endpoint);
  socket.addEventListener("open", () => handlers.open());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data.length > MAX_GATEWAY_FRAME_CHARS) {
        handlers.error(new Error("OpenClaw WebSocket frame exceeds the local size limit."));
        socket.close(1009, "frame too large");
        return;
      }
      handlers.message(event.data);
      return;
    }
    handlers.error(new Error("OpenClaw sent a non-text WebSocket frame."));
    socket.close(1003, "text frames required");
  });
  socket.addEventListener("close", (event) => handlers.close(event.code, event.reason));
  socket.addEventListener("error", () => handlers.error(new Error("OpenClaw WebSocket error.")));
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason)
  };
};

const extractMessageText = (message: unknown, max = MAX_RESULT_CHARS): string | undefined => {
  if (typeof message === "string") return bounded(message, max);
  if (!isRecord(message)) return undefined;
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  const content = message.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (!isRecord(part) || typeof part.text !== "string") return [];
      const type = part.type;
      if (type === "text" || (role === "user" && type === "input_text") || (role !== "user" && (type === "input_text" || type === "output_text"))) {
        return [part.text];
      }
      return [];
    });
    if (parts.length) text = parts.join("\n");
  }
  if (text === undefined && typeof message.text === "string") text = message.text;
  return text === undefined ? undefined : bounded(text, max);
};

const parseChatPayload = (frame: EventFrame): ChatPayload | undefined => {
  if (frame.event !== "chat" || !isRecord(frame.payload)) return undefined;
  const payload = frame.payload;
  const state = payload.state;
  const sessionKey = remoteId(payload.sessionKey);
  const runId = remoteId(payload.runId);
  if (
    !sessionKey ||
    !runId ||
    (state !== "status" && state !== "delta" && state !== "final" && state !== "aborted" && state !== "error")
  ) return undefined;
  return {
    state,
    sessionKey,
    runId,
    agentId: remoteId(payload.agentId, 256),
    seq: typeof payload.seq === "number" && Number.isSafeInteger(payload.seq) && payload.seq >= 0 ? payload.seq : undefined,
    phase: nonempty(payload.phase),
    message: payload.message,
    deltaText: typeof payload.deltaText === "string" ? payload.deltaText : undefined,
    replace: payload.replace === true,
    errorMessage: nonempty(payload.errorMessage),
    errorKind: nonempty(payload.errorKind)
  };
};

const helloProjection = (hello: HelloOk): OpenClawHello => ({
  protocol: hello.protocol,
  serverVersion: remoteId(hello.server?.version, 128),
  connectionId: remoteId(hello.server?.connId)
});

export class OpenClawConnector {
  private client?: GatewayProtocolClient<ConnectPlan>;
  private onStatus?: OpenClawStartOptions["onStatus"];
  private onTaskEvent?: OpenClawStartOptions["onTaskEvent"];
  private target?: string;
  private bootstrapToken?: string;
  private started = false;
  private hello?: OpenClawHello;
  private terminalError?: Error;
  private readonly waiters = new Set<Waiter>();
  private readonly tasks = new Map<string, OpenClawTaskRef>();
  private readonly taskByRun = new Map<string, string>();
  private readonly lastSequenceByRun = new Map<string, number>();
  private readonly liveTextByRun = new Map<string, string>();
  private readonly acceptedTasks = new Set<string>();
  private readonly terminalSignatures = new Map<string, string>();
  private readonly reconciliations = new Map<string, Promise<OpenClawReconciliation>>();
  private readonly reconcileTimers = new Set<ReturnType<typeof setTimeout>>();

  start(options: OpenClawStartOptions): void {
    if (this.client) this.stop();
    const endpoint = normalizeOpenClawEndpoint(options.endpoint);
    const target = nonempty(options.target);
    const bootstrapToken = nonempty(options.bootstrapToken);
    const clientInfo: ConnectParams["client"] = {
      id: "webchat",
      version: "voicear",
      platform: typeof navigator === "undefined" ? "web" : navigator.platform || "web",
      mode: "ui"
    };
    const { credentialStore, onStatus, onTaskEvent } = options;
    const tokenStore: GatewayBrowserDeviceTokenStore = {
      load: async (params) => {
        const token = await credentialStore.tokenStore.load(params);
        if (!token || hasExactOperatorScopes(token.scopes)) return token;
        await credentialStore.tokenStore.clear(params);
        return null;
      },
      store: async (params) => {
        if (!hasExactOperatorScopes(params.scopes)) {
          throw new OpenClawConnectorError("OpenClaw issued unexpected device scopes.", "UNEXPECTED_DEVICE_SCOPES");
        }
        await credentialStore.tokenStore.store({ ...params, scopes: [...OPERATOR_SCOPES] });
      },
      clear: (params) => credentialStore.tokenStore.clear(params)
    };
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const identity = await credentialStore.loadOrCreateIdentity();
        if (!identity || !nonempty(identity.deviceId) || !nonempty(identity.publicKey) || typeof identity.sign !== "function") {
          throw new OpenClawConnectorError("OpenClaw device identity is unavailable.", "DEVICE_IDENTITY_UNAVAILABLE");
        }
        return identity;
      },
      tokenStore
    });

    this.onStatus = onStatus;
    this.onTaskEvent = onTaskEvent;
    this.target = target;
    this.bootstrapToken = bootstrapToken;
    this.started = true;
    this.hello = undefined;
    this.terminalError = undefined;
    this.emitStatus("connecting");

    let client: GatewayProtocolClient<ConnectPlan>;
    client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => createBrowserSocket(endpoint, handlers),
      createRequestId: () => crypto.randomUUID(),
      buildConnectPlan: async ({ nonce, generation }) => ({
        generation,
        auth: await lifecycle.buildPlan({
          client: clientInfo,
          role: "operator",
          defaultScopes: OPERATOR_SCOPES,
          bootstrapScopes: OPERATOR_SCOPES,
          bootstrapToken: this.bootstrapToken,
          preferBootstrapToken: true,
          nonce
        })
      }),
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: plan.auth.scopes,
        device: plan.auth.device,
        auth: plan.auth.auth,
        locale: typeof navigator === "undefined" ? undefined : navigator.language,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent
      } satisfies ConnectParams),
      onConnectPlanError: (error) => {
        const normalized = connectorError(error, "DEVICE_AUTH_FAILED");
        this.fail(normalized);
        return { closeCode: 4008, closeReason: "connect setup failed", stop: true, error: normalized };
      },
      onConnectHello: (hello, context) => {
        void this.acceptHello(client, lifecycle, hello, context.plan);
      },
      onConnectFailure: (error) => this.handleConnectFailure(error),
      resolveClose: (context) => {
        const failure = context.connectFailure?.error;
        const details = failure instanceof GatewayProtocolRequestError ? failure.details : undefined;
        const retry =
          this.started &&
          !this.terminalError &&
          !shouldPauseGatewayReconnect({
            details,
            tokenMismatchIsTerminal: true,
            protocolMismatchIsTerminal: true,
            clientVersionMismatchIsTerminal: true
          });
        return { retry, notify: true, pendingError: failure };
      },
      onClose: (_context, decision) => {
        if (this.client !== client) return;
        this.hello = undefined;
        if (!this.started) return;
        if (this.terminalError) {
          this.emitStatus(
            this.terminalError instanceof OpenClawPairingRequiredError ? "pairing_required" : "error",
            {
            error: this.terminalError,
            requestId: this.terminalError instanceof OpenClawPairingRequiredError ? this.terminalError.requestId : undefined
            }
          );
        } else {
          this.emitStatus(decision.retry ? "reconnecting" : "error");
        }
      },
      onConnectError: (error) => {
        if (this.client === client && this.started && !this.terminalError) {
          this.emitStatus("reconnecting", { error: connectorError(error, "CONNECTION_FAILED") });
        }
      },
      onSocketFactoryError: (error) => this.fail(connectorError(error, "WEBSOCKET_UNAVAILABLE")),
      shouldRetrySocketFactoryError: () => false,
      onEvent: (frame) => this.handleEvent(frame),
      onGap: () => this.reconcileTrackedTasks(),
      handshake: { mode: "require-challenge", timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      requestTimeoutMs: REQUEST_TIMEOUT_MS
    });
    this.client = client;
    client.start();
  }

  stop(): void {
    const callback = this.onStatus;
    this.started = false;
    this.bootstrapToken = undefined;
    this.hello = undefined;
    this.terminalError = undefined;
    this.rejectWaiters(new OpenClawConnectorError("OpenClaw connector stopped.", "STOPPED"));
    this.client?.stop();
    this.client = undefined;
    this.onStatus = undefined;
    this.onTaskEvent = undefined;
    this.target = undefined;
    this.tasks.clear();
    this.taskByRun.clear();
    this.lastSequenceByRun.clear();
    this.liveTextByRun.clear();
    this.acceptedTasks.clear();
    this.terminalSignatures.clear();
    this.reconciliations.clear();
    for (const timer of this.reconcileTimers) clearTimeout(timer);
    this.reconcileTimers.clear();
    try {
      callback?.("stopped");
    } catch {
      // Host callbacks cannot be allowed to break transport cleanup.
    }
  }

  test(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<OpenClawHello> {
    return this.waitUntilConnected(timeoutMs);
  }

  needsRestart(): boolean {
    return !this.started || Boolean(this.terminalError);
  }

  waitUntilConnected(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<OpenClawHello> {
    if (this.hello) return Promise.resolve(this.hello);
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.started) {
      return Promise.reject(new OpenClawConnectorError("OpenClaw connector has not been started.", "NOT_STARTED"));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new OpenClawConnectorError("Timed out connecting to OpenClaw.", "CONNECT_TIMEOUT"));
        }, Math.max(1, timeoutMs))
      };
      this.waiters.add(waiter);
    });
  }

  async submit(input: { taskId: string; sessionKey: string; instruction: string }): Promise<OpenClawTaskRef> {
    const client = this.connectedClient();
    const taskId = this.required(input.taskId, "taskId");
    const sessionKey = this.sessionKey(input.sessionKey);
    if (!input.instruction.trim()) {
      throw new OpenClawConnectorError("OpenClaw instruction must not be empty.", "INVALID_TASK");
    }
    let task = this.rememberTask({ taskId, sessionKey });
    let payload: unknown;
    try {
      payload = await client.request<unknown>("chat.send", {
        sessionKey,
        ...(this.target ? { agentId: this.target } : {}),
        message: input.instruction,
        idempotencyKey: taskId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenClaw submission failed.";
      const definitive = error instanceof GatewayProtocolRequestError || /gateway not connected|invalid request frame/i.test(message);
      if (definitive) this.tasks.delete(taskId);
      else this.scheduleReconcile(task, MUTATION_RECONCILE_DELAY_MS);
      throw new OpenClawSubmissionError(message, !definitive, { cause: error });
    }
    const record = isRecord(payload) ? payload : {};
    const runId = remoteId(record.runId);
    const status = nonempty(record.status) ?? "started";
    if (status === "error" || status === "timeout") {
      const error = new OpenClawConnectorError(
        status === "timeout" ? "OpenClaw task timed out while starting." : "OpenClaw rejected the task.",
        status === "timeout" ? "OPENCLAW_TIMEOUT" : "OPENCLAW_SEND_ERROR"
      );
      this.emitTask({ ...this.eventBase(task, "live"), type: "failed", text: error.message, code: error.code, message: error.message });
      throw error;
    }
    if (this.client !== client || !this.started) return { taskId, sessionKey, ...(runId ? { runId } : {}) };
    task = this.rememberTask({ taskId, sessionKey, runId });
    this.emitAccepted(task, "live", remoteId(record.sessionId));
    if (status === "ok") this.scheduleReconcile(task);
    return task;
  }

  reconcile(input: OpenClawTaskRef): Promise<OpenClawReconciliation> {
    const task = this.rememberTask({
      taskId: this.required(input.taskId, "taskId"),
      sessionKey: this.sessionKey(input.sessionKey),
      runId: remoteId(input.runId)
    });
    const current = this.reconciliations.get(task.taskId);
    if (current) return current;
    const pending = this.reconcileOnce(task).finally(() => {
      if (this.reconciliations.get(task.taskId) === pending) this.reconciliations.delete(task.taskId);
    });
    this.reconciliations.set(task.taskId, pending);
    return pending;
  }

  async cancel(input: OpenClawTaskRef): Promise<void> {
    const client = this.connectedClient();
    const task = this.rememberTask({
      taskId: this.required(input.taskId, "taskId"),
      sessionKey: this.sessionKey(input.sessionKey),
      runId: remoteId(input.runId)
    });
    await client.request("chat.abort", {
      sessionKey: task.sessionKey,
      ...(this.target ? { agentId: this.target } : {}),
      ...(task.runId ? { runId: task.runId } : {})
    });
    this.scheduleReconcile(task, MUTATION_RECONCILE_DELAY_MS);
    // Completion is emitted only after a terminal event/history proves it.
  }

  private async acceptHello(
    client: GatewayProtocolClient<ConnectPlan>,
    lifecycle: GatewayBrowserDeviceAuthLifecycle,
    hello: HelloOk,
    plan: ConnectPlan
  ) {
    if (hello.auth.role !== "operator") {
      this.fail(new OpenClawConnectorError("OpenClaw granted an unexpected device role.", "UNEXPECTED_DEVICE_ROLE"));
      client.stop();
      return;
    }
    if (!hasExactOperatorScopes(hello.auth.scopes)) {
      this.fail(new OpenClawConnectorError("OpenClaw granted unexpected device scopes.", "UNEXPECTED_DEVICE_SCOPES"));
      client.stop();
      return;
    }
    try {
      await lifecycle.acceptHello(hello, plan.auth);
    } catch (error) {
      if (this.client === client) {
        this.fail(connectorError(error, "CREDENTIAL_PERSIST_FAILED"));
        client.stop();
      }
      return;
    }
    if (this.client !== client || !this.started || !client.connected) return;
    this.bootstrapToken = undefined;
    this.terminalError = undefined;
    this.hello = helloProjection(hello);
    this.emitStatus("connected");
    this.resolveWaiters(this.hello);
    this.reconcileTrackedTasks();
  }

  private handleConnectFailure(error: GatewayProtocolRequestError) {
    const details = readPairingConnectErrorDetails(error.details);
    if (details) {
      const formatted = formatConnectErrorMessage({ message: error.message, details: error.details });
      const request = details.requestId ? ` Request ID: ${details.requestId}.` : "";
      const pairing = new OpenClawPairingRequiredError(
        `${formatted}${request}`,
        details.requestId,
        details.reason,
        { cause: error }
      );
      this.fail(pairing);
      return { closeCode: 4008, closeReason: "pairing required", stop: true, error: pairing };
    }
    const normalized = new OpenClawConnectorError(
      formatConnectErrorMessage({ message: error.message, details: error.details }),
      error.gatewayCode || error.code || "CONNECT_REJECTED",
      { cause: error }
    );
    const terminal = shouldPauseGatewayReconnect({
      details: error.details,
      tokenMismatchIsTerminal: true,
      protocolMismatchIsTerminal: true,
      clientVersionMismatchIsTerminal: true
    });
    if (terminal) this.fail(normalized);
    return {
      closeCode: 4008,
      closeReason: "connect rejected",
      stop: terminal,
      error: normalized
    };
  }

  private handleEvent(frame: EventFrame) {
    const payload = parseChatPayload(frame);
    if (!payload || (this.target && payload.agentId && payload.agentId !== this.target)) return;
    let task = this.taskForEvent(payload);
    if (!task) return;
    if (task.runId !== payload.runId) {
      task = this.rememberTask({ ...task, runId: payload.runId });
    }
    if (payload.seq !== undefined) {
      const previous = this.lastSequenceByRun.get(payload.runId);
      if (previous !== undefined && payload.seq <= previous) return;
      if (previous !== undefined && payload.seq > previous + 1) this.scheduleReconcile(task);
      this.lastSequenceByRun.set(payload.runId, payload.seq);
    }
    const base = this.eventBase(task, "live", undefined, payload.seq);
    if (payload.state === "status") {
      if (payload.phase) {
        this.emitTask({ ...base, type: "progress", text: bounded(payload.phase.replaceAll("_", " "), MAX_PROGRESS_CHARS), sequence: payload.seq });
      }
      return;
    }
    if (payload.state === "delta") {
      const current = this.liveTextByRun.get(payload.runId) ?? "";
      const snapshot = extractMessageText(payload.message, MAX_RESULT_CHARS);
      const delta = payload.deltaText ?? "";
      let next: string;
      if (payload.replace) {
        next = delta;
      } else if (!current) {
        next = snapshot ?? delta;
      } else if (snapshot !== undefined) {
        const prefixLength = snapshot.length - delta.length;
        next = prefixLength === current.length && snapshot.slice(0, prefixLength) === current
          ? `${current}${delta}`
          : snapshot;
      } else {
        next = `${current}${delta}`;
      }
      next = bounded(next, MAX_RESULT_CHARS);
      this.liveTextByRun.set(payload.runId, next);
      if (next) this.emitTask({ ...base, type: "progress", text: bounded(next, MAX_PROGRESS_CHARS), sequence: payload.seq });
      return;
    }
    const liveText = this.liveTextByRun.get(payload.runId);
    this.liveTextByRun.delete(payload.runId);
    if (payload.state === "final") {
      const result = extractMessageText(payload.message) ?? (liveText ? bounded(liveText, MAX_RESULT_CHARS) : "");
      this.emitTask({ ...base, type: "completed", text: result, result });
      if (!result) this.scheduleReconcile(task);
    } else if (payload.state === "aborted") {
      this.emitTask({ ...base, type: "canceled" });
    } else {
      const message = bounded(payload.errorMessage ?? extractMessageText(payload.message, MAX_ERROR_CHARS) ?? "OpenClaw task failed.", MAX_ERROR_CHARS);
      this.emitTask({ ...base, type: "failed", text: message, code: payload.errorKind ?? "OPENCLAW_RUN_ERROR", message });
    }
  }

  private async reconcileOnce(initial: OpenClawTaskRef): Promise<OpenClawReconciliation> {
    const client = this.connectedClient();
    const history = await client.request<ChatHistory>("chat.history", {
      sessionKey: initial.sessionKey,
      ...(this.target ? { agentId: this.target } : {}),
      limit: HISTORY_LIMIT,
      maxChars: MAX_RESULT_CHARS
    });
    if (this.client !== client || !this.started) {
      throw new OpenClawConnectorError("OpenClaw connector stopped during reconciliation.", "STOPPED");
    }
    const task = this.tasks.get(initial.taskId) ?? initial;
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    let runId = task.runId;
    let result: string | undefined;
    let sequence: number | undefined;
    let sawEvidence = false;
    let latestObservedRunId: string | undefined;
    for (const message of messages) {
      const identity = readSessionMessageIdentity(message);
      latestObservedRunId = remoteId(identity?.runId) ?? latestObservedRunId;
      const matches =
        identity?.idempotencyKey === task.taskId ||
        Boolean(runId && remoteId(identity?.runId) === runId) ||
        (!runId && Boolean(remoteId(identity?.runId) && identity?.idempotencyKey === task.taskId));
      if (!matches) continue;
      sawEvidence = true;
      runId ??= remoteId(identity?.runId);
      const messageSequence = readSessionMessageSequence(message);
      if (messageSequence !== null) sequence = Math.max(sequence ?? 0, messageSequence);
      if (identity?.role === "assistant") {
        const text = extractMessageText(message);
        if (text !== undefined) result = text;
      }
    }
    const inFlightRunId = remoteId(history?.inFlightRun?.runId);
    runId ??= inFlightRunId === task.taskId ? inFlightRunId : undefined;
    const remembered = this.rememberTask({ ...task, runId });
    const remoteSessionId = remoteId(history?.sessionInfo?.sessionId) ?? remoteId(history?.sessionId);
    const activeRunIds = Array.isArray(history?.sessionInfo?.activeRunIds)
      ? history.sessionInfo.activeRunIds.flatMap((value) => remoteId(value) ?? [])
      : [];
    const running = Boolean(runId && (inFlightRunId === runId || activeRunIds.includes(runId)));
    const progress = running
      ? bounded(
          typeof history?.inFlightRun?.text === "string" ? history.inFlightRun.text : result ?? "",
          MAX_PROGRESS_CHARS
        )
      : undefined;
    const sessionStatus = nonempty(history?.sessionInfo?.status);
    const sessionStatusApplies = sawEvidence && (!latestObservedRunId || latestObservedRunId === runId);
    const base = this.taskIdentity(remembered, remoteSessionId, sequence);
    let reconciliation: OpenClawReconciliation;
    if (running) {
      reconciliation = { ...base, status: "running", progress };
      this.emitAccepted(remembered, "reconcile", remoteSessionId);
      if (progress) this.emitTask({ ...base, source: "reconcile", type: "progress", text: progress });
    } else if (sessionStatusApplies && sessionStatus === "killed") {
      reconciliation = { ...base, status: "canceled" };
      this.emitTask({ ...base, source: "reconcile", type: "canceled" });
    } else if (sessionStatusApplies && (sessionStatus === "failed" || sessionStatus === "timeout")) {
      const message = bounded(nonempty(history?.sessionInfo?.lastRunError) ?? `OpenClaw task ${sessionStatus}.`, MAX_ERROR_CHARS);
      const code = sessionStatus === "timeout" ? "OPENCLAW_TIMEOUT" : "OPENCLAW_RUN_ERROR";
      reconciliation = { ...base, status: "failed", error: { code, message } };
      this.emitTask({ ...base, source: "reconcile", type: "failed", text: message, code, message });
    } else if (result !== undefined || (sessionStatusApplies && sessionStatus === "done")) {
      const finalResult = result ?? "";
      reconciliation = { ...base, status: "completed", result: finalResult };
      this.emitTask({ ...base, source: "reconcile", type: "completed", text: finalResult, result: finalResult });
    } else {
      reconciliation = { ...base, status: "unknown" };
    }
    if (runId && sequence !== undefined) this.lastSequenceByRun.set(runId, sequence);
    return reconciliation;
  }

  private taskForEvent(payload: ChatPayload) {
    const taskId = this.taskByRun.get(payload.runId);
    if (taskId) return this.tasks.get(taskId);
    const candidates = [...this.tasks.values()].filter(
      (task) => task.sessionKey === payload.sessionKey && !this.terminalSignatures.has(task.taskId)
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private rememberTask(task: OpenClawTaskRef) {
    const previous = this.tasks.get(task.taskId);
    if (previous?.runId && previous.runId !== task.runId) this.taskByRun.delete(previous.runId);
    const remembered = { ...task, runId: task.runId ?? previous?.runId };
    this.tasks.set(task.taskId, remembered);
    if (remembered.runId) this.taskByRun.set(remembered.runId, remembered.taskId);
    return remembered;
  }

  private taskIdentity(task: OpenClawTaskRef, remoteSessionId?: string, sequence?: number): OpenClawTaskIdentity {
    return {
      taskId: task.taskId,
      sessionKey: task.sessionKey,
      ...(task.runId ? { runId: task.runId, remoteRunId: task.runId } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    };
  }

  private eventBase(
    task: OpenClawTaskRef,
    source: OpenClawTaskEventBase["source"],
    remoteSessionId?: string,
    sequence?: number
  ): OpenClawTaskEventBase {
    return { ...this.taskIdentity(task, remoteSessionId, sequence), source };
  }

  private emitAccepted(
    task: OpenClawTaskRef,
    source: OpenClawTaskEventBase["source"],
    remoteSessionId?: string
  ) {
    if (this.acceptedTasks.has(task.taskId)) return;
    this.acceptedTasks.add(task.taskId);
    this.emitTask({ ...this.eventBase(task, source, remoteSessionId), type: "accepted" });
  }

  private emitTask(event: OpenClawTaskEvent) {
    if (event.type === "completed" || event.type === "failed" || event.type === "canceled") {
      const signature = event.type === "completed"
        ? `${event.type}\0${event.result}`
        : event.type === "failed"
          ? `${event.type}\0${event.code}\0${event.message}`
          : event.type;
      if (this.terminalSignatures.get(event.taskId) === signature) return;
      this.terminalSignatures.set(event.taskId, signature);
    }
    try {
      this.onTaskEvent?.(event);
    } catch {
      // A host render/reducer failure must not break the connector.
    }
  }

  private scheduleReconcile(task: OpenClawTaskRef, delayMs = 0) {
    if (!delayMs) {
      void this.reconcile(task).catch(() => undefined);
      return;
    }
    const client = this.client;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(timer);
      if (this.client === client && this.started && !this.terminalSignatures.has(task.taskId)) {
        void this.reconcile(task).catch(() => undefined);
      }
    }, delayMs);
    this.reconcileTimers.add(timer);
  }

  private reconcileTrackedTasks() {
    for (const task of this.tasks.values()) {
      if (!this.terminalSignatures.has(task.taskId)) this.scheduleReconcile(task);
    }
  }

  private connectedClient() {
    if (!this.client || !this.hello) {
      throw new OpenClawConnectorError("OpenClaw is not connected.", "NOT_CONNECTED");
    }
    return this.client;
  }

  private required(value: string, label: string) {
    const normalized = nonempty(value);
    if (!normalized) throw new OpenClawConnectorError(`${label} must not be empty.`, "INVALID_TASK");
    return normalized;
  }

  private sessionKey(value: string) {
    const sessionKey = this.required(value, "sessionKey");
    if (sessionKey.length > 512) {
      throw new OpenClawConnectorError("sessionKey must not exceed 512 characters.", "INVALID_TASK");
    }
    return sessionKey;
  }

  private fail(error: Error) {
    if (this.terminalError) return;
    this.terminalError = error;
    this.hello = undefined;
    this.emitStatus(
      error instanceof OpenClawPairingRequiredError ? "pairing_required" : "error",
      {
      error,
      requestId: error instanceof OpenClawPairingRequiredError ? error.requestId : undefined
      }
    );
    this.rejectWaiters(error);
  }

  private emitStatus(status: OpenClawStatus, detail?: OpenClawStatusDetail) {
    try {
      this.onStatus?.(status, detail);
    } catch {
      // Status rendering is host-owned; transport stays alive if it throws.
    }
  }

  private resolveWaiters(hello: OpenClawHello) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(hello);
    }
    this.waiters.clear();
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
