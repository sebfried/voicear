import assert from "node:assert/strict";
import {
  MAX_AGENT_RESULT_CHARS,
  agentConnectionRevision,
  agentConnectionSchema,
  agentTaskSchema,
  boundedAgentText,
  firstAttentionTransition,
  isUnreadAgentTask,
  normalizeAgentEndpoint,
  reconcileAgentTaskStatus,
  resolveAgentConnection,
  sortAgentTasks,
  type AgentConnection,
  type AgentTask
} from "./agent-state.ts";

const connectionId = "019c1a24-b0c3-7a00-8000-000000000001";
const secondConnectionId = "019c1a24-b0c3-7a00-8000-000000000002";
const chatId = "019c1a24-b0c3-7a00-8000-000000000003";
const taskId = "019c1a24-b0c3-7a00-8000-000000000004";

const connection = (overrides: Partial<AgentConnection> = {}): AgentConnection => ({
  id: connectionId,
  kind: "hermes",
  label: "Hermes Home",
  endpoint: "https://hermes.example.test",
  enabled: true,
  isDefault: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
});

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  id: taskId,
  connectionId,
  chatId,
  instruction: "Prüfe den Build.",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  ...overrides
});

assert.equal(normalizeAgentEndpoint(" HTTPS://Example.COM:443/api/// "), "https://example.com/api");
assert.equal(normalizeAgentEndpoint("http://localhost:8080/"), "http://localhost:8080");
assert.equal(normalizeAgentEndpoint("ws://127.0.0.1:9000/socket/"), "ws://127.0.0.1:9000/socket");
for (const endpoint of [
  "http://[::1]:8080/",
  "http://agent.example.test",
  "ws://192.168.1.4:9000",
  "ftp://example.test",
  "https://user:secret@example.test",
  "https://example.test/path?token=secret",
  "https://example.test/#fragment",
  "https:example.test",
  "not a url"
]) assert.throws(() => normalizeAgentEndpoint(endpoint), TypeError);

const parsedConnection = agentConnectionSchema.parse({ ...connection(), endpoint: "wss://AGENT.example.test/gateway/" });
assert.equal(parsedConnection.endpoint, "wss://agent.example.test/gateway");
assert.equal(parsedConnection.label, "Hermes Home");
assert.notEqual(
  agentConnectionRevision(parsedConnection),
  agentConnectionRevision({ ...parsedConnection, target: "other-agent" })
);
assert.notEqual(
  agentConnectionRevision(parsedConnection),
  agentConnectionRevision({ ...parsedConnection, updatedAt: parsedConnection.updatedAt + 1 })
);
assert.equal(agentConnectionSchema.safeParse({ ...connection(), id: "not-a-uuid" }).success, false);
assert.equal(agentConnectionSchema.safeParse({ ...connection(), endpoint: "http://10.0.0.2" }).success, false);

const oversized = "x".repeat(MAX_AGENT_RESULT_CHARS + 100);
const bounded = boundedAgentText(oversized);
assert.equal(bounded.length, MAX_AGENT_RESULT_CHARS);
assert.match(bounded, /truncated\]$/);
assert.equal(boundedAgentText("short"), "short");
assert.equal(agentTaskSchema.safeParse(task({ result: oversized })).success, false);
assert.equal(agentTaskSchema.safeParse(task({ result: bounded })).success, true);

const running = task();
const completed = task({ status: "completed", updatedAt: 2, result: "Fertig." });
assert.equal(isUnreadAgentTask(running), false);
assert.equal(isUnreadAgentTask(completed), true);
assert.equal(isUnreadAgentTask(task({ status: "unknown" })), true);
assert.equal(isUnreadAgentTask(task({ status: "completed", readAt: 3 })), false);
assert.equal(isUnreadAgentTask(task({ status: "canceled" })), false);
assert.equal(firstAttentionTransition(running, completed), true);
assert.equal(firstAttentionTransition(completed, { ...completed }), false);
assert.equal(firstAttentionTransition(undefined, completed), true);
assert.equal(reconcileAgentTaskStatus("canceling", "running"), "canceling");
assert.equal(reconcileAgentTaskStatus("canceling", "unknown"), "canceling");
assert.equal(reconcileAgentTaskStatus("canceling", "completed"), "completed");
assert.equal(reconcileAgentTaskStatus("running", "unknown"), "unknown");

const unreadOlder = task({ id: "019c1a24-b0c3-7a00-8000-000000000010", status: "failed", updatedAt: 2, error: { code: "failed", message: "Nope" } });
const readNewer = task({ id: "019c1a24-b0c3-7a00-8000-000000000011", status: "completed", updatedAt: 5, readAt: 6 });
const unreadNewer = task({ id: "019c1a24-b0c3-7a00-8000-000000000012", status: "completed", updatedAt: 4 });
const unsorted = [readNewer, unreadOlder, unreadNewer];
assert.deepEqual(sortAgentTasks(unsorted).map(({ id }) => id), [unreadNewer.id, unreadOlder.id, readNewer.id]);
assert.deepEqual(unsorted.map(({ id }) => id), [readNewer.id, unreadOlder.id, unreadNewer.id]);

const hermes = connection();
const openclaw = connection({ id: secondConnectionId, kind: "openclaw", label: "OpenClaw Office", isDefault: true, createdAt: 2 });
assert.equal(resolveAgentConnection([hermes]).status, "resolved");
assert.deepEqual(resolveAgentConnection([hermes, openclaw]), { status: "resolved", connection: openclaw });
assert.deepEqual(resolveAgentConnection([hermes, openclaw], "  OPENCLAW   OFFICE "), { status: "resolved", connection: openclaw });
assert.deepEqual(resolveAgentConnection([hermes, openclaw], secondConnectionId.toUpperCase()), { status: "resolved", connection: openclaw });
assert.equal(resolveAgentConnection([hermes, { ...openclaw, isDefault: false }]).status, "ambiguous");
assert.equal(resolveAgentConnection([{ ...hermes, label: "Same" }, { ...openclaw, label: " same ", isDefault: false }], "same").status, "ambiguous");
assert.equal(resolveAgentConnection([{ ...hermes, enabled: false }]).status, "missing");
assert.equal(resolveAgentConnection([hermes], "unknown").status, "missing");

console.log("agent state tests passed");
