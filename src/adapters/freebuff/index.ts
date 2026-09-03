/**
 * Freebuff ProviderAdapter — routes a Codex Responses turn through the Freebuff backend's
 * OpenAI-compatible chat-completions endpoint using the multi-account pool.
 */
import type { IncomingMeta, ProviderAdapter } from "../base";
import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../../types";
import { adapterFailureFromMessage } from "../../lib/errors";
import { AccountLease, WaitingRoomError, errorText, type AccountPool } from "../../freebuff/pool";
import { UpstreamError } from "../../freebuff/upstream";
import {
  buildChatCompletionRequest,
  collectReasoningTexts,
  parseChatSseChunk,
  stopReasonFromFinish,
  transformTodosArgsToUpdatePlan,
  usageFromChunk,
  type ChatChunk,
} from "./convert";

export interface FreebuffAdapterOptions {
  pool: AccountPool;
  /** Resolve the upstream agent id that serves a given model (registry model→agent map). */
  resolveAgentId: (modelId: string) => string;
  /** Resolve the model tier (free/premium/limited/paused) for notifications. */
  resolveModelTier?: (modelId: string) => "free" | "premium" | "limited" | "paused";
}

/** Errors where the upstream run is known-bad and a fresh run should be tried once. */
function isRunInvalid(status: number, errorBody: string): boolean {
  if (status !== 400) return false;
  const message = errorBody.toLowerCase();
  return message.includes("runid not found") || message.includes("runid not running");
}

function isSessionInvalid(status: number, errorBody: string): boolean {
  if (status < 400) return false;
  let parsed: { error?: unknown } = {};
  try {
    parsed = JSON.parse(errorBody) as { error?: unknown };
  } catch {
    return false;
  }
  const code = typeof parsed.error === "string" ? parsed.error.trim() : "";
  if (
    [
      // FREEBUFF_GATE_CODES entries with endsTheSession: true (shared wire contract in
      // the CLI source, freebuff-session.ts). Recovery for all of them is identical:
      // forget the dead window and re-admit (end + POST) before re-sending.
      "waiting_room_required",
      "session_expired",
      "session_superseded",
      "session_model_mismatch",
      "freebuff_update_required",
      "waiting_room_queued",
    ].includes(code)
  ) {
    return true;
  }
  // Free sessions are pinned server-side to the egress IP that created them. When the
  // machine's IP changes (WiFi hop, VPN toggle, router reconnect) the upstream rejects
  // the still-cached session with a free_mode_* 403 — the fix is a fresh admission
  // (end + POST) from the CURRENT IP, so every free_mode_* code retries the session.
  return code.startsWith("free_mode_");
}

const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Abort-aware sleep used between capacity-deferral retries. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export function createFreebuffAdapter(options: FreebuffAdapterOptions): ProviderAdapter {
  const { pool, resolveAgentId, resolveModelTier } = options;

  return {
    name: "freebuff",
    async runTurn(
      parsed: CodexParsedRequest,
      incoming: IncomingMeta,
      emit: (event: AdapterEvent) => void,
    ): Promise<void> {
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await runTurnOnce(parsed, incoming, emit);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };

  async function runTurnOnce(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    let lastFailure: { message: string; status?: number } | undefined;
    // Gate rejections (seat gone / superseded / model mismatch) each get a fresh
    // admission; two retries ride out a flap plus a model switch.
    for (let attempt = 0; attempt < 3; attempt++) {
      let lease: AccountLease | undefined;
      try {
        const acquired = await pool.acquire(resolveAgentId(parsed.modelId), parsed.modelId, incoming.abortSignal);
        lease = acquired.lease;
        const account = acquired.account;
        console.info(`[${account.name}] routing request (model: ${parsed.modelId}) via run: ${lease.runId}`);
        // Premium/limited models meter their pools server-side — surface a quota notice
        // instead of silently burning the daily allowance.
        resolveModelTier?.(parsed.modelId) !== undefined
          && resolveModelTier(parsed.modelId) !== "free"
          && pool.notifyModelUse(account.name, parsed.modelId, resolveModelTier(parsed.modelId));

        const body = buildChatCompletionRequest(parsed, { runId: lease.runId, sessionInstanceId: lease.sessionInstanceId });
        let result = await account.chat(body, incoming.abortSignal);
        // The backend sheds free-mode completions under saturation with 429
        // free_mode_capacity_deferred (see the CLI source: model-provider.ts surfaces a
        // "high demand" indicator while the AI-SDK retry loop absorbs the wait). Mirror
        // that: back off and retry the SAME session a few times before surfacing an error.
        let capacityRetries = 0;
        while (
          "errorBody" in result &&
          result.status === 429 &&
          result.errorBody.includes("free_mode_capacity_deferred") &&
          capacityRetries < 3 &&
          !incoming.abortSignal?.aborted
        ) {
          capacityRetries += 1;
          console.warn(`[${account.name}] free-mode capacity deferral, backing off 10s (retry ${capacityRetries}/3)`);
          await sleepAbortable(10_000, incoming.abortSignal);
          result = await account.chat(body, incoming.abortSignal);
        }

        if ("errorBody" in result) {
          if (isSessionInvalid(result.status, result.errorBody)) {
            console.warn(`[${account.name}] free session invalid, refreshing and retrying`);
            account.invalidateSession(result.errorBody.trim());
            await lease.release();
            lastFailure = { message: result.errorBody || `upstream status ${result.status}`, status: result.status };
            continue;
          }
          if (isRunInvalid(result.status, result.errorBody)) {
            console.warn(`[${account.name}] run ${lease.runId} invalid, rotating and retrying`);
            await lease.invalidate(result.errorBody.trim());
            lastFailure = { message: result.errorBody || `upstream status ${result.status}`, status: result.status };
            continue;
          }
          if (result.status === 401) {
            account.markCooldown(30 * 60_000, "upstream auth rejected token");
            account.invalidateSession("upstream auth rejected token");
          }
          await lease.release();
          emitUpstreamFailure(emit, result.status, result.errorBody);
          return;
        }

        await streamUpstreamResponse(result.response, account, emit);
        await lease.release();
        return;
      } catch (error) {
        if (error instanceof WaitingRoomError) {
          emitWaitingRoomFailure(emit, error);
          return;
        }
        if (incoming.abortSignal?.aborted) {
          emit({ type: "incomplete", reason: "client_cancelled" });
          return;
        }
        const message = errorText(error);
        const status = error instanceof UpstreamError ? error.status : undefined;
        if (lease) {
          await lease.release().catch(() => {});
        }
        // Transport-level failures are worth one retry across a different account.
        lastFailure = { message, status };
        if (attempt === 0 && (status === undefined || RETRYABLE_UPSTREAM_STATUS.has(status))) continue;
        emitError(emit, message, status);
        return;
      }
    }
    const message = lastFailure?.message ?? "upstream run expired twice in a row";
    emitError(emit, message, lastFailure?.status);
  }

  function emitUpstreamFailure(emit: (event: AdapterEvent) => void, status: number, errorBody: string): void {
    const { httpStatus, error } = adapterFailureFromMessage(
      `${status} ${errorBody.trim() || "upstream error"}`,
    );
    emit({
      type: "error",
      message: error.message,
      status: httpStatus,
      errorType: error.type,
      code: error.code ?? undefined,
    });
  }

  function emitWaitingRoomFailure(emit: (event: AdapterEvent) => void, error: WaitingRoomError): void {
    emit({
      type: "error",
      message: error.message,
      status: 503,
      errorType: "server_error",
      code: "waiting_room_queued",
    });
  }

  function emitError(emit: (event: AdapterEvent) => void, message: string, status?: number): void {
    const { httpStatus, error } = adapterFailureFromMessage(message);
    emit({
      type: "error",
      message: error.message,
      status: status ?? httpStatus,
      errorType: error.type,
      code: error.code ?? undefined,
    });
  }

  async function streamUpstreamResponse(
    response: Response,
    account: { recordUsage(delta: { inputTokens: number; outputTokens: number; totalTokens?: number }): void },
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let currentText = "";
    let currentReasoning = "";
    let sawText = false;
    let sawReasoning = false;

    interface OpenToolCall {
      id: string;
      name: string;
      args: string;
      outputIndex: number;
      /** write_todos bridge: args buffered and translated to update_plan at flush. */
      deferred?: boolean;
    }
    const openToolCalls = new Map<number, OpenToolCall>();
    let nextOutputIndex = 0;

    let usage: CodexUsage | undefined;
    let stopReason: string | undefined;

    const closeText = () => {
      if (!sawText) return;
      sawText = false;
      currentText = "";
    };
    const closeReasoning = () => {
      if (!sawReasoning) return;
      sawReasoning = false;
      currentReasoning = "";
    };
    // Track deltas for the emit stream; the bridge accumulates its own copies.

    const processChunk = (chunk: ChatChunk) => {
      if (chunk.error) {
        const message = typeof chunk.error === "object" && chunk.error !== null && "message" in chunk.error
          ? String((chunk.error as { message?: unknown }).message)
          : JSON.stringify(chunk.error);
        throw new UpstreamError(message, 502);
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        const mapped = usageFromChunk(chunk.usage ?? undefined);
        if (mapped) usage = mapped.usage;
        return;
      }
      const delta = choice.delta ?? {};

      const reasoningTexts = [
        ...collectReasoningTexts(delta.reasoning_content),
        ...collectReasoningTexts(delta.reasoning),
      ];
      if (reasoningTexts.length > 0) {
        if (sawText) closeText();
        if (!sawReasoning) {
          sawReasoning = true;
          currentReasoning = "";
        }
        for (const text of reasoningTexts) {
          currentReasoning += text;
          emit({ type: "thinking_delta", thinking: text });
        }
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (sawReasoning) closeReasoning();
        if (!sawText) {
          sawText = true;
          currentText = "";
        }
        currentText += delta.content;
        emit({ type: "text_delta", text: delta.content, phase: "final_answer" });
      }        for (const toolCall of delta.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        let open = openToolCalls.get(index);
        const arrivingName = toolCall.function?.name;
        if (!open) {
          // Defer the start until the tool name arrives: the Responses wire requires a named
          // tool_call_start, and some backends split id/name/args across separate chunks.
          if (!arrivingName) continue;
          if (sawText) closeText();
          if (sawReasoning) closeReasoning();
          // write_todos (our signature-tool bridge) is presented to Codex as update_plan:
          // buffered, renamed, and args-transformed at flush so Codex never sees the alias.
          const deferred = arrivingName === "write_todos";
          open = {
            id: toolCall.id ?? `call_${index}_${Date.now()}`,
            name: deferred ? "update_plan" : arrivingName,
            args: "",
            outputIndex: nextOutputIndex++,
            ...(deferred ? { deferred: true } : {}),
          };
          openToolCalls.set(index, open);
          if (!deferred) emit({ type: "tool_call_start", id: open.id, name: open.name });
        }
        if (toolCall.id && open.id !== toolCall.id) open.id = toolCall.id;
        if (arrivingName && open.name !== arrivingName && !open.deferred) open.name = arrivingName;
        if (toolCall.function?.arguments) {
          open.args += toolCall.function.arguments;
          if (!open.deferred) emit({ type: "tool_call_delta", arguments: toolCall.function.arguments });
        }
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        const mappedUsage = usageFromChunk(chunk.usage ?? undefined);
        if (mappedUsage) usage = mappedUsage.usage;
      } else if (chunk.usage) {
        const mappedUsage = usageFromChunk(chunk.usage);
        if (mappedUsage) usage = mappedUsage.usage;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const chunk = parseChatSseChunk(line);
          if (chunk) processChunk(chunk);
        }
      }
      const tail = parseChatSseChunk(buffer);
      if (tail) processChunk(tail);
    } finally {
      reader.releaseLock();
    }

    for (const open of openToolCalls.values()) {
      if (open.deferred) {
        emit({ type: "tool_call_start", id: open.id, name: open.name });
        emit({ type: "tool_call_delta", arguments: transformTodosArgsToUpdatePlan(open.args) });
      }
      emit({ type: "tool_call_end" });
    }

    closeReasoning();
    closeText();

    if (usage) account.recordUsage(usage);
    emit({
      type: "done",
      stopReason: stopReasonFromFinish(stopReason) ?? "stop",
      endTurn: openToolCalls.size === 0,
      usage,
    });
  }
}
