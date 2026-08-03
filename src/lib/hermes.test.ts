import assert from "node:assert/strict";
import {
  getHermesRun,
  mapHermesRun,
  stopHermesRun,
  submitHermesRun,
  testHermesConnection
} from "./hermes.ts";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
const replies: Response[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" }
});

globalThis.fetch = (async (input, init) => {
  calls.push({ url: String(input), init });
  const response = replies.shift();
  if (!response) throw new Error("Missing test response.");
  return response;
}) as typeof fetch;

try {
  const credential = { apiKey: "hermes-secret", endpointBinding: "https://hermes.example.test" };
  replies.push(json({ features: { run_submission: true, run_status: true } }));
  await testHermesConnection("hermes.example.test/v1/", credential);
  assert.equal(calls[0]?.url, "https://hermes.example.test/v1/capabilities");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer hermes-secret");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);

  replies.push(json({ run_id: "run_1", status: "started" }, 202));
  const submitted = await submitHermesRun("https://hermes.example.test/v1", credential, {
    taskId: "task-1",
    sessionId: "chat-1",
    input: "Run the checks."
  });
  assert.deepEqual(submitted, { runId: "run_1", sessionId: "chat-1", status: "queued", result: undefined, error: undefined });
  const submitHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(submitHeaders.get("Idempotency-Key"), "task-1");
  assert.equal(submitHeaders.get("X-Hermes-Session-Id"), null);
  assert.equal(submitHeaders.get("X-Hermes-Session-Key"), null);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { input: "Run the checks.", session_id: "chat-1" });

  replies.push(json({ run_id: "run_1", session_id: "chat-1", status: "waiting_for_approval" }));
  assert.equal((await getHermesRun("https://hermes.example.test", credential, "run_1")).status, "needs_approval");

  replies.push(json({ run_id: "run_1", status: "stopping" }));
  assert.equal((await stopHermesRun("https://hermes.example.test", credential, "run_1")).status, "stopping");

  assert.equal(mapHermesRun({ run_id: "run_2", status: "cancelled" }).status, "canceled");
  assert.equal(mapHermesRun({ run_id: "run_3", status: "new_future_status" }).status, "unknown");
  assert.throws(() => mapHermesRun({ run_id: "run_4", status: 4 }), /invalid run status/);

  replies.push(json({ error: { message: "Bad hermes-secret", code: "bad_auth" } }, 401));
  await assert.rejects(
    testHermesConnection("https://hermes.example.test", credential),
    (error: unknown) => error instanceof Error &&
      error.message === "Hermes request failed (401): Bad [redacted] (bad_auth)"
  );

  await assert.rejects(
    submitHermesRun("http://remote.example.test", credential, { taskId: "t", sessionId: "s", input: "x" }),
    /must use HTTPS/
  );

  const callsBeforeBindingCheck = calls.length;
  await assert.rejects(
    testHermesConnection("https://old-hermes.example.test", credential),
    /bound to a different endpoint/
  );
  assert.equal(calls.length, callsBeforeBindingCheck, "a key must never be sent to a different endpoint");

  let oversizedCanceled = false;
  replies.push(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(600_000).fill(0x20));
    },
    cancel() {
      oversizedCanceled = true;
    }
  }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(
    testHermesConnection("https://hermes.example.test", credential),
    /response is too large/
  );
  assert.equal(oversizedCanceled, true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Hermes connector tests passed");
