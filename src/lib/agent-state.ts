import { z } from "zod";

export const MAX_AGENT_RESULT_CHARS = 262_144;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ATTENTION_STATUSES = new Set(["needs_input", "needs_approval", "completed", "failed", "unknown"]);
const TERMINAL_STATUSES = new Set<AgentTaskStatus>(["completed", "failed", "canceled"]);
const TRUNCATED = "\n[… truncated]";

export const normalizeAgentEndpoint = (value: string) => {
  const input = value.trim();
  if (!input) throw new TypeError("Agent endpoint is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new TypeError("Agent endpoint must be a valid URL.");
  if (input.slice(input.indexOf("://") + 3).match(/[?#]/)) throw new TypeError("Agent endpoint must not contain a query or fragment.");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Agent endpoint must be a valid URL.");
  }

  if (url.username || url.password) throw new TypeError("Agent endpoint must not contain credentials.");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const local = (url.protocol === "http:" || url.protocol === "ws:") && LOOPBACK_HOSTS.has(url.hostname.toLocaleLowerCase("en"));
  if (!secure && !local) throw new TypeError("Agent endpoint must use HTTPS/WSS, except on loopback.");

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
};

export const agentEndpointSchema = z.string().transform((value, context) => {
  try {
    return normalizeAgentEndpoint(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid agent endpoint." });
    return z.NEVER;
  }
});

export const agentKindSchema = z.enum(["hermes", "openclaw"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

const timestampSchema = z.number().int().nonnegative();

export const agentConnectionSchema = z.object({
  id: z.uuid(),
  kind: agentKindSchema,
  label: z.string().trim().min(1).max(80),
  endpoint: agentEndpointSchema,
  target: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export type AgentConnection = z.infer<typeof agentConnectionSchema>;

export const agentConnectionRevision = (
  connection: Pick<AgentConnection, "id" | "kind" | "endpoint" | "target" | "updatedAt">
) => JSON.stringify([connection.id, connection.kind, connection.endpoint, connection.target ?? null, connection.updatedAt]);

export const agentTaskStatusSchema = z.enum([
  "queued",
  "running",
  "needs_input",
  "needs_approval",
  "canceling",
  "completed",
  "failed",
  "canceled",
  "unknown"
]);

export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;

export const reconcileAgentTaskStatus = (previous: AgentTaskStatus, incoming: AgentTaskStatus) =>
  previous === "canceling" && !TERMINAL_STATUSES.has(incoming) ? "canceling" : incoming;

const optionalRemoteId = z.string().trim().min(1).max(512).optional();
const boundedTextSchema = z.string().max(MAX_AGENT_RESULT_CHARS);

export const agentTaskSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  chatId: z.uuid(),
  instruction: z.string().trim().min(1).max(65_536),
  status: agentTaskStatusSchema,
  remoteRunId: optionalRemoteId,
  remoteSessionId: optionalRemoteId,
  lastSequence: z.number().int().nonnegative().optional(),
  progress: boundedTextSchema.optional(),
  result: boundedTextSchema.optional(),
  error: z.object({
    code: z.string().trim().min(1).max(128),
    message: boundedTextSchema
  }).strict().optional(),
  readAt: timestampSchema.optional(),
  voiceAnnouncedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

export type AgentTask = z.infer<typeof agentTaskSchema>;

export const boundedAgentText = (value: string) => {
  if (value.length <= MAX_AGENT_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_AGENT_RESULT_CHARS - TRUNCATED.length)}${TRUNCATED}`;
};

const isAttentionStatus = (status: AgentTaskStatus) => ATTENTION_STATUSES.has(status);

export const isUnreadAgentTask = (task: AgentTask) => task.readAt === undefined && isAttentionStatus(task.status);

export const firstAttentionTransition = (previous: AgentTask | null | undefined, next: AgentTask) =>
  isAttentionStatus(next.status) && previous?.status !== next.status;

export const sortAgentTasks = (tasks: readonly AgentTask[]) => [...tasks].sort((left, right) =>
  Number(isUnreadAgentTask(right)) - Number(isUnreadAgentTask(left)) ||
  right.updatedAt - left.updatedAt ||
  left.id.localeCompare(right.id)
);

export type AgentConnectionResolution =
  | { status: "resolved"; connection: AgentConnection }
  | { status: "ambiguous"; matches: AgentConnection[] }
  | { status: "missing"; matches: [] };

const normalizeLookup = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
const sortConnections = (connections: AgentConnection[]) => [...connections].sort((left, right) =>
  normalizeLookup(left.label).localeCompare(normalizeLookup(right.label), "de") ||
  left.createdAt - right.createdAt ||
  left.id.localeCompare(right.id)
);

const connectionResolution = (matches: AgentConnection[]): AgentConnectionResolution => {
  const sorted = sortConnections(matches);
  if (sorted.length === 1) return { status: "resolved", connection: sorted[0] };
  if (sorted.length > 1) return { status: "ambiguous", matches: sorted };
  return { status: "missing", matches: [] };
};

export const resolveAgentConnection = (connections: readonly AgentConnection[], query?: string): AgentConnectionResolution => {
  const enabled = connections.filter(({ enabled }) => enabled);
  const needle = query === undefined ? "" : normalizeLookup(query);
  if (needle) {
    const byId = enabled.filter(({ id }) => normalizeLookup(id) === needle);
    if (byId.length) return connectionResolution(byId);
    return connectionResolution(enabled.filter(({ label }) => normalizeLookup(label) === needle));
  }

  const defaults = enabled.filter(({ isDefault }) => isDefault);
  return connectionResolution(defaults.length ? defaults : enabled);
};
