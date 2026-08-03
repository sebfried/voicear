# Agent tasks, Inbox, and Voice handoff

Status: implemented behavior, 2026-08-01

## Product contract

Delegated work is a durable local task, separate from the OpenAI Realtime transcript:

1. Voicear creates and persists a `queued` task.
2. It submits the instruction to the selected OpenClaw or Hermes connection.
3. The native agent continues independently of the tab.
4. Live events or polling update the local task snapshot.
5. Reopening or foregrounding Voicear reconciles unfinished tasks.
6. Attention states appear in the Inbox; they are never inserted into `Chat.messages`.

There is no closed-app push. Results recovered on startup, focus, `pageshow`, `online`, or visibility reconciliation update the Inbox silently. Starting Voice later, merely becoming idle, and reconciliation do not replay stored results into Voice.

Only an attention transition that arrives live while a visible Realtime session is already connected is eligible for automatic speech. If the current turn is busy, that same live notification may wait until the turn finishes; ending Voice clears the in-memory queue.

## State and storage

The persisted task states are:

```text
queued → running → completed | failed | canceled
                   ↘ needs_input | needs_approval
running → canceling → canceled | completed | failed
queued → unknown
```

`unknown` means submission may have succeeded remotely but Voicear cannot prove it. Terminal states are `completed`, `failed`, and `canceled`.

The implemented task record contains the local UUID, `connectionId`, originating `chatId`, instruction, status, optional remote run/session IDs and OpenClaw sequence, bounded progress/result/error text, timestamps, `readAt`, and `voiceAnnouncedAt`. It deliberately has no event log, cross-connector cursor, artifact model, or copied credential.

Persistence is split by purpose:

- connection profiles and the default selection: `localStorage` (`voicear.agentConnections`);
- chats, agent credentials, and task snapshots: IndexedDB `voicear`, schema version 2, stores `chats`, `agentCredentials`, and `agentTasks`;
- existing v1 chat records are preserved during the v2 upgrade.

Credentials are referenced by connection ID and never copied into tasks, messages, errors, URLs, or exports. Stored and remote task data is validated, and persisted result text is bounded to 256 KiB.

## Submission and recovery

Voicear saves the complete `queued` task before making the network request. For OpenClaw it also saves the deterministic session key before `chat.send`; the task UUID is the idempotency key, and history can recover the real run ID if the acknowledgement is lost. Hermes receives the same UUID as `Idempotency-Key`. A remote acknowledgement adds the remaining remote identifiers.

An ambiguous submit is not retried automatically; the task becomes `unknown`. This matters especially for Hermes because the current Runs handler does not provide a reliable idempotency guarantee. See [Hermes' current API-server source](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py).

Recovery is debounced and single-flight:

- OpenClaw keeps its Gateway socket connected, reconnects with the official client, deduplicates live run sequences, and reconciles from `chat.history`/`inFlightRun` after reconnect or a sequence gap.
- Hermes polls `GET /v1/runs/{run_id}` every five seconds while visible and reconciles unfinished runs on lifecycle events.
- socket events and timers are optimizations; remote history/run status is authoritative.

Recovery/lifecycle reconciliation never creates a second task or a Voice announcement. A periodic poll that observes a new result during the already-active session is the Hermes live-delivery path and may announce it once.

## Inbox behavior

The Inbox badge counts unread `needs_input`, `needs_approval`, `completed`, `failed`, and diagnostic `unknown` tasks. Progress, running, canceled, and already-read entries do not increment it.

Opening the Inbox does not mark anything read and does not expose unread output. Reading is explicit:

- `[ READ ]` marks that one card read and reveals its plain-text output;
- a spoken request uses `read_agent_message` for that exact task;
- a matching successful Voice response marks the task read;
- merely listing messages returns trusted IDs/statuses, never remote output.

`needs_input` and `needs_approval` are currently descriptive states only. Voice may explain what the agent requests, but Voicear does not answer or approve it. Reply/approval tools are deferred until their native UI and connector flow exist.

All remote content is rendered with `textContent`; there is no remote HTML, image, embed, link fetch, or Markdown execution.

## Voice tools

The implemented tools are intentionally small:

- `list_agent_connections`
- `open_agent_setup`
- `test_agent_connection`
- `delegate_to_agent`
- `list_agent_messages`
- `read_agent_message`
- `open_agent_inbox`

`delegate_to_agent` returns after submission with trusted task metadata; it never waits for the long-running result.

`read_agent_message` requires explicit user intent. Its function result is only a trusted background acknowledgement such as `{ status: "processing", taskId }`; raw agent output is not returned as a normal tool result.

## Safe active-Voice delivery

For an eligible live arrival, Voicear creates an isolated Realtime response with:

- bounded agent data supplied as untrusted response input;
- fixed app-owned instructions to summarize in the user's language;
- `tools: []` and `tool_choice: "none"`;
- audio output only and a small output-token limit;
- metadata that ties `response.done` to the local batch.

Completed output is summarized automatically. Failures are summarized safely. Input and approval requests are only described; the model must not decide or act on them.

Neither the untrusted payload nor its assistant summary enters the default conversation: the one-off response uses `conversation: "none"` and cannot call tools. `voiceAnnouncedAt` is written only after the matching `response.done` for the unchanged task version; an explicit `read_agent_message` additionally writes `readAt`.

This follows Realtime's isolated response-input mechanism and the Agents SDK transport request API: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations#text-inputs-and-outputs) and [OpenAI Agents JS `RealtimeSession`](https://openai.github.io/openai-agents-js/openai/agents/realtime/classes/realtimesession/).

## Trust boundary

Authentication proves which connector returned bytes; it does not turn those bytes into trusted instructions.

- Never place remote output in system/developer instructions.
- Never automatically feed it into another task or tool call.
- Keep trusted IDs/statuses separate from untrusted text.
- Require a fresh user request for side effects, follow-on delegation, secrets, files, replies, or approvals.
- Do not log credentials or raw authenticated frames.
- Bound and validate identifiers, sequences, status transitions, and text.

See [OWASP Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) and [OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

## Acceptance checks

- The task exists in IndexedDB before submission.
- An ambiguous submit becomes `unknown`, never a blind duplicate.
- Reconnect/reconciliation updates the existing task.
- Startup, generic idle, and reconciliation never replay old results to Voice.
- A live arrival in an active Voice session produces one isolated, tool-free summary.
- Explicit Voice reading uses `read_agent_message` and marks read only after the matching response finishes.
- Approval/input requests are described but never answered automatically.
- Realtime history updates cannot remove or reanimate Inbox content.
- Existing chats survive the IndexedDB v2 migration.

The existing `set_font_size` Voice tool remains independent: it changes `--font-scale` immediately and persists the selected 80–180% scale locally.
