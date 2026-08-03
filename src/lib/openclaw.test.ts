import assert from "node:assert/strict";
import {
  OpenClawConnector,
  OpenClawConnectorError,
  OpenClawPairingRequiredError,
  OpenClawSubmissionError,
  normalizeOpenClawEndpoint,
  type OpenClawCredentialStore,
  type OpenClawTaskEvent
} from "./openclaw.ts";

type SocketListener = (event: Record<string, unknown>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    assert.equal(this.readyState, FakeWebSocket.OPEN);
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  receiveRaw(data: string) {
    this.emit("message", { data });
  }

  private emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: FakeWebSocket
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const nextRequest = async (socket: FakeWebSocket, method: string, seen = new Set<string>()) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const raw of socket.sent) {
      const frame = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
      if (frame.method === method && !seen.has(frame.id)) {
        seen.add(frame.id);
        return frame;
      }
    }
    await tick();
  }
  throw new Error(`Missing ${method} request`);
};

const respond = (socket: FakeWebSocket, request: { id: string }, payload: unknown) =>
  socket.receive({ type: "res", id: request.id, ok: true, payload });

const connect = async (
  connector: OpenClawConnector,
  socket: FakeWebSocket,
  auth: Record<string, unknown> = {
    deviceToken: "issued-device-token",
    role: "operator",
    scopes: ["operator.read", "operator.write"]
  }
) => {
  const ready = connector.waitUntilConnected();
  socket.open();
  socket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "challenge" } });
  const request = await nextRequest(socket, "connect");
  respond(socket, request, {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.7.2-beta.6", connId: "connection-1" },
    auth
  });
  return { hello: await ready, request };
};

const waitForSocketAfter = async (count: number) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const socket = FakeWebSocket.instances[count];
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Missing reconnected socket");
};

assert.equal(normalizeOpenClawEndpoint("wss://agent.example.test"), "wss://agent.example.test/");
assert.equal(normalizeOpenClawEndpoint("ws://127.0.0.1:18789"), "ws://127.0.0.1:18789/");
for (const endpoint of [
  "ws://192.168.1.20:18789",
  "https://agent.example.test",
  "wss://user:secret@agent.example.test",
  "wss://agent.example.test/?token=secret"
]) {
  assert.throws(() => normalizeOpenClawEndpoint(endpoint));
}

const storedTokens: string[] = [];
const credentials = {
  loadOrCreateIdentity: async () => ({
    deviceId: "device-id",
    publicKey: "public-key",
    sign: async () => "signature"
  }),
  tokenStore: {
    load: async () => null,
    store: async ({ token }: { token: string }) => { storedTokens.push(token); },
    clear: async () => undefined
  }
} satisfies OpenClawCredentialStore;

const oversizedConnector = new OpenClawConnector();
oversizedConnector.start({ endpoint: "wss://oversized.example.test", credentialStore: credentials });
const oversizedSocket = FakeWebSocket.instances.at(-1)!;
oversizedSocket.open();
oversizedSocket.receiveRaw("x".repeat(1024 * 1024 + 1));
assert.equal(oversizedSocket.readyState, FakeWebSocket.CLOSED);
oversizedConnector.stop();

const statuses: string[] = [];
const events: OpenClawTaskEvent[] = [];
const connector = new OpenClawConnector();
connector.start({
  endpoint: "wss://agent.example.test",
  bootstrapToken: "bootstrap-secret",
  credentialStore: credentials,
  onStatus: (status) => statuses.push(status),
  onTaskEvent: (event) => events.push(event)
});
const socket = FakeWebSocket.instances.at(-1)!;
const { hello, request: connectRequest } = await connect(connector, socket);
assert.deepEqual(hello, { protocol: 4, serverVersion: "2026.7.2-beta.6", connectionId: "connection-1" });
assert.equal(connectRequest.params.minProtocol, 4);
assert.equal(connectRequest.params.maxProtocol, 4);
assert.deepEqual(connectRequest.params.client, {
  id: "webchat",
  version: "voicear",
  platform: navigator.platform || "web",
  mode: "ui"
});
assert.deepEqual(connectRequest.params.scopes, ["operator.read", "operator.write"]);
assert.equal("caps" in connectRequest.params, false);
assert.deepEqual(connectRequest.params.auth, { bootstrapToken: "bootstrap-secret" });
assert.deepEqual(connectRequest.params.device, {
  id: "device-id",
  publicKey: "public-key",
  signature: "signature",
  signedAt: (connectRequest.params.device as { signedAt: number }).signedAt,
  nonce: "challenge"
});
assert.deepEqual(storedTokens, ["issued-device-token"]);
assert.deepEqual(statuses, ["connecting", "connected"]);
assert.equal(connector.needsRestart(), false);

const seen = new Set<string>([connectRequest.id]);
const submitted = connector.submit({ taskId: "task-1", sessionKey: "agent:main:test", instruction: "Do it" });
const sendRequest = await nextRequest(socket, "chat.send", seen);
assert.equal(sendRequest.params.idempotencyKey, "task-1");
respond(socket, sendRequest, { status: "started", runId: "run-1" });
assert.deepEqual(await submitted, { taskId: "task-1", sessionKey: "agent:main:test", runId: "run-1" });

socket.receive({
  type: "event",
  event: "chat",
  seq: 1,
  payload: {
    state: "delta",
    sessionKey: "agent:main:test",
    runId: "run-1",
    seq: 1,
    deltaText: "Working"
  }
});
socket.receive({
  type: "event",
  event: "chat",
  seq: 2,
  payload: {
    state: "final",
    sessionKey: "agent:main:test",
    runId: "run-1",
    seq: 2,
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] }
  }
});
assert.equal(events.find((event) => event.type === "progress")?.text, "Working");
const completed = events.find((event) => event.type === "completed");
assert.equal(completed?.text, "Done");
assert.equal(completed?.runId, "run-1");
assert.equal(completed?.sequence, 2);
assert.equal(completed?.source, "live");

const reconciled = connector.reconcile({ taskId: "task-2", sessionKey: "agent:main:test", runId: "run-2" });
const historyRequest = await nextRequest(socket, "chat.history", seen);
respond(socket, historyRequest, {
  sessionId: "session-2",
  sessionInfo: { sessionId: "session-2", status: "done" },
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Canonical result" }],
    __openclaw: { idempotencyKey: "run-2", seq: 4 }
  }]
});
assert.deepEqual(await reconciled, {
  taskId: "task-2",
  sessionKey: "agent:main:test",
  runId: "run-2",
  remoteRunId: "run-2",
  remoteSessionId: "session-2",
  sequence: 4,
  status: "completed",
  result: "Canonical result"
});
assert.equal(events.findLast((event) => event.taskId === "task-2")?.source, "reconcile");

const canceled = connector.cancel({ taskId: "task-3", sessionKey: "agent:main:test", runId: "run-3" });
const abortRequest = await nextRequest(socket, "chat.abort", seen);
assert.equal(abortRequest.params.runId, "run-3");
respond(socket, abortRequest, { ok: true });
await canceled;
await new Promise((resolve) => setTimeout(resolve, 550));
const cancelHistoryRequest = await nextRequest(socket, "chat.history", seen);
respond(socket, cancelHistoryRequest, {
  sessionInfo: { status: "aborted" },
  messages: []
});
await tick();

const stoppedAfterAck = connector.submit({
  taskId: "task-stopped-after-ack",
  sessionKey: "agent:main:test",
  instruction: "Accept before local stop"
});
const stoppedAfterAckRequest = await nextRequest(socket, "chat.send", seen);
respond(socket, stoppedAfterAckRequest, { status: "started", runId: "run-stopped-after-ack" });
connector.stop();
assert.deepEqual(await stoppedAfterAck, {
  taskId: "task-stopped-after-ack",
  sessionKey: "agent:main:test",
  runId: "run-stopped-after-ack"
});

const pairingConnector = new OpenClawConnector();
pairingConnector.start({ endpoint: "wss://pair.example.test", credentialStore: credentials });
const pairingSocket = FakeWebSocket.instances.at(-1)!;
const pairingResult = pairingConnector.waitUntilConnected();
pairingSocket.open();
pairingSocket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "pair" } });
const pairingRequest = await nextRequest(pairingSocket, "connect");
pairingSocket.receive({
  type: "res",
  id: pairingRequest.id,
  ok: false,
  error: {
    code: "INVALID_REQUEST",
    message: "pairing required",
    details: { code: "PAIRING_REQUIRED", reason: "not-paired", requestId: "pair-123", pauseReconnect: true }
  }
});
await assert.rejects(pairingResult, (error: unknown) =>
  error instanceof OpenClawPairingRequiredError && error.requestId === "pair-123"
);
assert.equal(pairingConnector.needsRestart(), true);
pairingConnector.stop();

const storedTokenClears: string[] = [];
const storedTokenConnector = new OpenClawConnector();
storedTokenConnector.start({
  endpoint: "wss://stored.example.test",
  credentialStore: {
    loadOrCreateIdentity: credentials.loadOrCreateIdentity,
    tokenStore: {
      load: async () => ({ token: "stored-device-token", scopes: ["operator.read", "operator.write"] }),
      store: async () => undefined,
      clear: async ({ deviceId }) => { storedTokenClears.push(deviceId); }
    }
  }
});
const storedTokenSocket = FakeWebSocket.instances.at(-1)!;
const { request: storedTokenRequest } = await connect(storedTokenConnector, storedTokenSocket, {
  role: "operator",
  scopes: ["operator.read", "operator.write"]
});
assert.deepEqual(storedTokenRequest.params.auth, {
  token: "stored-device-token",
  deviceToken: "stored-device-token"
});
assert.deepEqual(storedTokenClears, []);
storedTokenConnector.stop();

const invalidStoredScopeClears: string[] = [];
const invalidStoredScopeConnector = new OpenClawConnector();
invalidStoredScopeConnector.start({
  endpoint: "wss://stored-scopes.example.test",
  credentialStore: {
    loadOrCreateIdentity: credentials.loadOrCreateIdentity,
    tokenStore: {
      load: async () => ({ token: "over-scoped-token", scopes: ["operator.admin"] }),
      store: async () => undefined,
      clear: async ({ deviceId }) => { invalidStoredScopeClears.push(deviceId); }
    }
  }
});
const invalidStoredScopeSocket = FakeWebSocket.instances.at(-1)!;
const { request: invalidStoredScopeRequest } = await connect(invalidStoredScopeConnector, invalidStoredScopeSocket, {
  role: "operator",
  scopes: ["operator.read", "operator.write"]
});
assert.equal("auth" in invalidStoredScopeRequest.params, false);
assert.deepEqual(invalidStoredScopeClears, ["device-id"]);
invalidStoredScopeConnector.stop();

let invalidIssuedScopeStores = 0;
const invalidIssuedScopeConnector = new OpenClawConnector();
invalidIssuedScopeConnector.start({
  endpoint: "wss://issued-scopes.example.test",
  bootstrapToken: "bootstrap-secret",
  credentialStore: {
    loadOrCreateIdentity: credentials.loadOrCreateIdentity,
    tokenStore: {
      load: async () => null,
      store: async () => { invalidIssuedScopeStores += 1; },
      clear: async () => undefined
    }
  }
});
const invalidIssuedScopeSocket = FakeWebSocket.instances.at(-1)!;
const invalidIssuedScopeResult = invalidIssuedScopeConnector.waitUntilConnected();
invalidIssuedScopeSocket.open();
invalidIssuedScopeSocket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "scope" } });
const invalidIssuedScopeRequest = await nextRequest(invalidIssuedScopeSocket, "connect");
respond(invalidIssuedScopeSocket, invalidIssuedScopeRequest, {
  type: "hello-ok",
  protocol: 4,
  server: { version: "2026.7.2-beta.6", connId: "connection-scopes" },
  auth: { role: "operator", scopes: ["operator.admin"] }
});
await assert.rejects(invalidIssuedScopeResult, (error: unknown) =>
  error instanceof OpenClawConnectorError && error.code === "UNEXPECTED_DEVICE_SCOPES"
);
assert.equal(invalidIssuedScopeStores, 0);
invalidIssuedScopeConnector.stop();

const invalidRoleConnector = new OpenClawConnector();
invalidRoleConnector.start({
  endpoint: "wss://issued-role.example.test",
  credentialStore: credentials
});
const invalidRoleSocket = FakeWebSocket.instances.at(-1)!;
const invalidRoleResult = invalidRoleConnector.waitUntilConnected();
invalidRoleSocket.open();
invalidRoleSocket.receive({ type: "event", event: "connect.challenge", payload: { nonce: "role" } });
const invalidRoleRequest = await nextRequest(invalidRoleSocket, "connect");
respond(invalidRoleSocket, invalidRoleRequest, {
  type: "hello-ok",
  protocol: 4,
  server: { version: "2026.7.2-beta.6", connId: "connection-role" },
  auth: { role: "admin", scopes: ["operator.read", "operator.write"] }
});
await assert.rejects(invalidRoleResult, (error: unknown) =>
  error instanceof OpenClawConnectorError && error.code === "UNEXPECTED_DEVICE_ROLE"
);
invalidRoleConnector.stop();

const recoveryEvents: OpenClawTaskEvent[] = [];
const recoveryConnector = new OpenClawConnector();
recoveryConnector.start({
  endpoint: "wss://recovery.example.test",
  credentialStore: credentials,
  onTaskEvent: (event) => recoveryEvents.push(event)
});
const recoverySocket = FakeWebSocket.instances.at(-1)!;
const { request: recoveryConnectRequest } = await connect(recoveryConnector, recoverySocket);
const recoverySeen = new Set<string>([recoveryConnectRequest.id]);

const preAckReconciliation = recoveryConnector.reconcile({
  taskId: "real-run-pre-ack",
  sessionKey: "agent:main:recovery"
});
const preAckHistoryRequest = await nextRequest(recoverySocket, "chat.history", recoverySeen);
respond(recoverySocket, preAckHistoryRequest, {
  sessionId: "session-pre-ack",
  sessionInfo: { sessionId: "session-pre-ack", status: "done" },
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Recovered before ACK" }],
    __openclaw: { idempotencyKey: "real-run-pre-ack", seq: 7 }
  }]
});
assert.deepEqual(await preAckReconciliation, {
  taskId: "real-run-pre-ack",
  sessionKey: "agent:main:recovery",
  runId: "real-run-pre-ack",
  remoteRunId: "real-run-pre-ack",
  remoteSessionId: "session-pre-ack",
  sequence: 7,
  status: "completed",
  result: "Recovered before ACK"
});

const rejectedSubmit = recoveryConnector.submit({
  taskId: "task-rejected",
  sessionKey: "agent:main:recovery",
  instruction: "Reject me"
});
const rejectedSendRequest = await nextRequest(recoverySocket, "chat.send", recoverySeen);
recoverySocket.receive({
  type: "res",
  id: rejectedSendRequest.id,
  ok: false,
  error: { code: "INVALID_REQUEST", message: "Rejected by gateway" }
});
await assert.rejects(rejectedSubmit, (error: unknown) =>
  error instanceof OpenClawSubmissionError && !error.ambiguous && error.code === "SUBMISSION_REJECTED"
);

const timedOutSubmit = recoveryConnector.submit({
  taskId: "task-timeout",
  sessionKey: "agent:main:recovery",
  instruction: "Lose the acknowledgement"
});
await nextRequest(recoverySocket, "chat.send", recoverySeen);
recoverySocket.close(1006, "connection lost");
await assert.rejects(timedOutSubmit, (error: unknown) =>
  error instanceof OpenClawSubmissionError && error.ambiguous && error.code === "SUBMISSION_UNKNOWN"
);

const socketCount = FakeWebSocket.instances.length;
const reconnectedSocket = await waitForSocketAfter(socketCount);
const { request: reconnectRequest } = await connect(recoveryConnector, reconnectedSocket);
const reconnectedSeen = new Set<string>([reconnectRequest.id]);
const reconnectHistoryRequest = await nextRequest(reconnectedSocket, "chat.history", reconnectedSeen);
respond(reconnectedSocket, reconnectHistoryRequest, {
  sessionInfo: { status: "done" },
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Recovered after reconnect" }],
    __openclaw: { idempotencyKey: "task-timeout", seq: 8 }
  }]
});
await tick();
assert.equal(
  recoveryEvents.findLast((event) => event.taskId === "task-timeout")?.source,
  "reconcile"
);

const gapSubmit = recoveryConnector.submit({
  taskId: "task-gap",
  sessionKey: "agent:main:recovery",
  instruction: "Bridge the gap"
});
const gapSendRequest = await nextRequest(reconnectedSocket, "chat.send", reconnectedSeen);
respond(reconnectedSocket, gapSendRequest, { status: "started", runId: "task-gap" });
await gapSubmit;
reconnectedSocket.receive({ type: "event", event: "tick", seq: 1, payload: {} });
reconnectedSocket.receive({ type: "event", event: "tick", seq: 3, payload: {} });
const gapHistoryRequest = await nextRequest(reconnectedSocket, "chat.history", reconnectedSeen);
respond(reconnectedSocket, gapHistoryRequest, {
  sessionInfo: { status: "done" },
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Recovered after gap" }],
    __openclaw: { idempotencyKey: "task-gap", seq: 9 }
  }]
});
await tick();
assert.equal(
  recoveryEvents.findLast((event) => event.taskId === "task-gap")?.source,
  "reconcile"
);

const nativeSetTimeout = globalThis.setTimeout;
Object.defineProperty(globalThis, "setTimeout", {
  configurable: true,
  value: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = nativeSetTimeout(callback, delay === 30_000 || delay === 500 ? 0 : delay, ...args);
    if (delay === 30_000 && typeof timer === "object") {
      Object.defineProperty(timer, "unref", { configurable: true, value: () => timer });
    }
    return timer;
  }
});
try {
  await assert.rejects(
    recoveryConnector.submit({
      taskId: "task-request-timeout",
      sessionKey: "agent:main:recovery",
      instruction: "Time out before acknowledgement"
    }),
    (error: unknown) =>
      error instanceof OpenClawSubmissionError && error.ambiguous && error.code === "SUBMISSION_UNKNOWN"
  );
  const timeoutHistoryRequest = await nextRequest(reconnectedSocket, "chat.history", reconnectedSeen);
  respond(reconnectedSocket, timeoutHistoryRequest, { sessionInfo: { status: "running" }, messages: [] });
  await tick();
} finally {
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: nativeSetTimeout });
}
recoveryConnector.stop();

console.log("openclaw checks passed");
