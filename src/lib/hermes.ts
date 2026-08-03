const MAX_HEADER_CHARS = 256;
const MAX_API_KEY_CHARS = 8_192;
const MAX_INPUT_CHARS = 65_536;
const MAX_RESULT_CHARS = 262_144;
const MAX_RESPONSE_CHARS = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type HermesCredential = { apiKey: string; endpointBinding: string };

export type HermesRunStatus =
  | "queued"
  | "running"
  | "needs_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export type HermesRunSnapshot = {
  runId: string;
  sessionId?: string;
  status: HermesRunStatus;
  result?: string;
  error?: string;
};

export class HermesRequestError extends Error {
  readonly ambiguous: boolean;

  constructor(message: string, ambiguous: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "HermesRequestError";
    this.ambiguous = ambiguous;
  }
}

type JsonObject = Record<string, unknown>;
type RunFallback = { runId?: string; sessionId?: string };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedHeader = (label: string, value: unknown, maximum = MAX_HEADER_CHARS) => {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} is required.`);
  if (trimmed.length > maximum) throw new TypeError(`${label} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new TypeError(`${label} contains invalid characters.`);
  return trimmed;
};

const boundedInput = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Hermes input is required.");
  if (value.length > MAX_INPUT_CHARS) throw new TypeError("Hermes input is too long.");
  return value;
};

const boundedResult = (value: string) => value.length <= MAX_RESULT_CHARS
  ? value
  : `${value.slice(0, MAX_RESULT_CHARS - 14)}\n[… truncated]`;

const endpointUrl = (endpoint: string, route: string) => {
  const raw = endpoint.trim();
  if (!raw) throw new TypeError("Hermes endpoint is required.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new TypeError("Hermes endpoint must be a valid URL.");
  }

  if (url.username || url.password) throw new TypeError("Hermes endpoint must not contain credentials.");
  if (url.search || url.hash) throw new TypeError("Hermes endpoint must not contain a query or fragment.");
  const localHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLocaleLowerCase("en"));
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("Hermes endpoint must use HTTPS, except on loopback.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  const basePath = path === "/v1" || path.endsWith("/v1") ? path.slice(0, -3) : path;
  url.pathname = `${basePath}/v1/${route}`.replace(/\/{2,}/g, "/");
  return url;
};

const endpointBinding = (endpoint: string) => {
  const url = endpointUrl(endpoint, "");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
};

const credentialHeaders = (endpoint: string, credential: HermesCredential) => {
  if (endpointBinding(credential?.endpointBinding) !== endpointBinding(endpoint)) {
    throw new TypeError("Hermes credential is bound to a different endpoint.");
  }
  const apiKey = boundedHeader("Hermes API key", credential?.apiKey, MAX_API_KEY_CHARS);
  return {
    apiKey,
    headers: new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`
    })
  };
};

const knownError = (value: unknown) => {
  if (typeof value === "string") return value;
  if (!isObject(value)) return undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  return message && code ? `${message} (${code})` : message ?? code;
};

const httpError = (response: Response, payload: unknown, apiKey: string) => {
  const object = isObject(payload) ? payload : undefined;
  const detail = knownError(object?.error) ?? knownError(object?.message);
  const safeDetail = detail
    ?.split(apiKey).join("[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 1_024);
  return new Error(`Hermes request failed (${response.status})${safeDetail ? `: ${safeDetail}` : "."}`);
};

const readBoundedBody = async (response: Response, apiKey: string) => {
  const tooLarge = () => response.ok
    ? new Error("Hermes response is too large.")
    : httpError(response, undefined, apiKey);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_CHARS) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_CHARS) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
};

const readJson = async (response: Response, apiKey: string) => {
  const body = await readBoundedBody(response, apiKey);

  let payload: unknown;
  const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en") ?? "";
  if (contentType.includes("json")) {
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      if (!response.ok) throw httpError(response, undefined, apiKey);
      throw new Error("Hermes returned invalid JSON.");
    }
  } else if (response.ok) {
    throw new Error("Hermes returned a non-JSON response.");
  }

  if (!response.ok) throw httpError(response, payload, apiKey);
  if (!isObject(payload)) throw new Error("Hermes returned an invalid JSON object.");
  return payload;
};

const requestJson = async (
  endpoint: string,
  credential: HermesCredential,
  route: string,
  init: RequestInit,
  signal?: AbortSignal
) => {
  const { apiKey, headers } = credentialHeaders(endpoint, credential);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const url = endpointUrl(endpoint, route);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
  } catch (error) {
    throw new HermesRequestError(error instanceof Error ? error.message : "Hermes network request failed.", init.method === "POST", { cause: error });
  }
  try {
    return await readJson(response, apiKey);
  } catch (error) {
    if (!response.ok) throw error;
    throw new HermesRequestError(error instanceof Error ? error.message : "Hermes returned an invalid response.", init.method === "POST", { cause: error });
  }
};

const requiredString = (value: unknown, label: string, maximum = 512) => {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > maximum) {
    throw new Error(`Hermes returned an invalid ${label}.`);
  }
  return value;
};

const optionalString = (value: unknown, label: string, maximum = 512, allowEmpty = false) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new Error(`Hermes returned an invalid ${label}.`);
  }
  return value;
};

const mapStatus = (status: string): HermesRunStatus => {
  switch (status) {
    case "started":
    case "pending":
    case "queued":
      return "queued";
    case "in_progress":
    case "running":
      return "running";
    case "waiting_for_approval":
    case "needs_approval":
      return "needs_approval";
    case "canceling":
    case "cancelling":
    case "stopping":
      return "stopping";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "unknown";
  }
};

export const mapHermesRun = (value: unknown, fallback: RunFallback = {}): HermesRunSnapshot => {
  if (!isObject(value)) throw new Error("Hermes returned an invalid run snapshot.");
  const runId = requiredString(value.run_id ?? fallback.runId, "run ID");
  const sessionId = optionalString(value.session_id ?? fallback.sessionId, "session ID", 512);
  const status = mapStatus(requiredString(value.status, "run status", 64));
  const rawResult = optionalString(value.output ?? value.result, "run output", MAX_RESPONSE_CHARS, true);
  const result = rawResult === undefined ? undefined : boundedResult(rawResult);

  let error: string | undefined;
  if (value.error !== undefined && value.error !== null) {
    error = knownError(value.error);
    if (!error) throw new Error("Hermes returned an invalid run error.");
    error = boundedResult(error);
  }

  return { runId, sessionId, status, result, error };
};

export const testHermesConnection = async (
  endpoint: string,
  credential: HermesCredential,
  signal?: AbortSignal
) => {
  const capabilities = await requestJson(endpoint, credential, "capabilities", { method: "GET" }, signal);
  if (!isObject(capabilities.features) ||
      capabilities.features.run_submission !== true ||
      capabilities.features.run_status !== true) {
    throw new Error("Hermes server does not support background runs.");
  }
};

export const submitHermesRun = async (
  endpoint: string,
  credential: HermesCredential,
  request: { taskId: string; sessionId: string; input: string },
  signal?: AbortSignal
) => {
  const taskId = boundedHeader("Task ID", request.taskId);
  const sessionId = boundedHeader("Session ID", request.sessionId);
  const payload = await requestJson(endpoint, credential, "runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": taskId
    },
    body: JSON.stringify({ input: boundedInput(request.input), session_id: sessionId })
  }, signal);
  try {
    return mapHermesRun(payload, { sessionId });
  } catch (error) {
    throw new HermesRequestError(error instanceof Error ? error.message : "Hermes returned an invalid run.", true, { cause: error });
  }
};

export const getHermesRun = async (
  endpoint: string,
  credential: HermesCredential,
  runId: string,
  signal?: AbortSignal
) => {
  const id = boundedHeader("Run ID", runId, 512);
  return mapHermesRun(await requestJson(endpoint, credential, `runs/${encodeURIComponent(id)}`, { method: "GET" }, signal), {
    runId: id
  });
};

export const stopHermesRun = async (
  endpoint: string,
  credential: HermesCredential,
  runId: string,
  signal?: AbortSignal
) => {
  const id = boundedHeader("Run ID", runId, 512);
  return mapHermesRun(await requestJson(endpoint, credential, `runs/${encodeURIComponent(id)}/stop`, { method: "POST" }, signal), {
    runId: id
  });
};
