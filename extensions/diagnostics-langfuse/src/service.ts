import { Langfuse } from "langfuse";
import * as os from "os";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "../api.js";

type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushIntervalMs?: number;
  release?: string;
  userId?: string;
};

function resolveConfig(diagnostics: Record<string, unknown> | undefined): LangfuseConfig | null {
  const langfuse = diagnostics?.langfuse as Record<string, unknown> | undefined;
  if (!langfuse || langfuse.enabled !== true) {
    return null;
  }
  const publicKey = typeof langfuse.publicKey === "string" ? langfuse.publicKey : "";
  const secretKey = typeof langfuse.secretKey === "string" ? langfuse.secretKey : "";
  if (!publicKey || !secretKey) {
    return null;
  }
  return {
    publicKey,
    secretKey,
    baseUrl: typeof langfuse.baseUrl === "string" ? langfuse.baseUrl : undefined,
    flushIntervalMs:
      typeof langfuse.flushIntervalMs === "number" ? langfuse.flushIntervalMs : undefined,
    release: typeof langfuse.release === "string" ? langfuse.release : undefined,
    userId:
      typeof langfuse.userId === "string"
        ? langfuse.userId
        : os.userInfo().username,
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

type TraceEntry = { trace: ReturnType<Langfuse["trace"]>; startTimeMs: number };
type GenerationEntry = {
  generation: ReturnType<ReturnType<Langfuse["trace"]>["generation"]>;
  startTimeMs: number;
};
type SpanEntry = { span: ReturnType<ReturnType<Langfuse["trace"]>["span"]>; startTimeMs: number };

export function createDiagnosticsLangfuseService(): OpenClawPluginService {
  let client: Langfuse | null = null;
  let unsubscribe: (() => void) | null = null;
  let activeConfig: LangfuseConfig | null = null;

  const activeTraces = new Map<string, TraceEntry>();
  const activeGenerations = new Map<string, GenerationEntry>();
  const activeSpans = new Map<string, SpanEntry>();

  const stopStarted = async () => {
    const currentUnsubscribe = unsubscribe;
    const currentClient = client;
    unsubscribe = null;
    client = null;
    activeConfig = null;
    activeTraces.clear();
    activeGenerations.clear();
    activeSpans.clear();

    currentUnsubscribe?.();
    if (currentClient) {
      await currentClient.flushAsync().catch(() => undefined);
      await currentClient.shutdown().catch(() => undefined);
    }
  };

  // --- Handlers (closure over client + maps) ---

  function handleRunStarted(evt: Extract<DiagnosticEventPayload, { type: "run.started" }>) {
    if (!client) return;
    if (activeTraces.has(evt.runId)) return;

    // Read content fields from raw event
    const raw = evt as unknown as Record<string, unknown>;
    const trace = client.trace({
      id: evt.runId,
      name: `Run (${evt.channel ?? "unknown"} → ${evt.model ?? "unknown"})`,
      sessionId: evt.sessionId ?? evt.sessionKey ?? undefined,
      ...(activeConfig?.userId ? { userId: activeConfig.userId } : {}),
      input: raw.inputMessages ?? raw.promptText ?? undefined,
      metadata: {
        channel: evt.channel,
        provider: evt.provider,
        model: evt.model,
        trigger: evt.trigger,
        sessionKey: evt.sessionKey,
      },
    });

    activeTraces.set(evt.runId, { trace, startTimeMs: evt.ts });
  }

  function handleRunCompleted(evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>) {
    const entry = activeTraces.get(evt.runId);
    if (!entry) return;

    entry.trace.update({
      output: evt.outcome,
      metadata: {
        ...(evt.errorCategory ? { errorCategory: evt.errorCategory } : {}),
        ...(evt.blockedBy ? { blockedBy: evt.blockedBy } : {}),
        durationMs: evt.durationMs,
      },
    });

    activeTraces.delete(evt.runId);
    client?.flushAsync().catch(() => undefined);
  }

  function handleModelUsage(evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) {
    const traceEntry = findTraceForEvent(evt);
    if (!traceEntry) return;

    const usage = evt.usage;
    // Read content fields that exist at runtime but aren't in the TS types
    // (same pattern as diagnostics-otel's assignOtelModelContentAttributes)
    const raw = evt as unknown as Record<string, unknown>;
    traceEntry.trace.generation({
      name: `Model Usage (${evt.model ?? "unknown"})`,
      model: evt.model,
      startTime: new Date(evt.ts - (evt.durationMs ?? 0)),
      endTime: new Date(evt.ts),
      input: raw.inputMessages ?? undefined,
      output: raw.outputMessages ?? undefined,
      usage: {
        input: usage.input ?? usage.promptTokens ?? 0,
        output: usage.output ?? 0,
      },
      metadata: {
        provider: evt.provider,
        channel: evt.channel,
        agentId: evt.agentId,
        costUsd: evt.costUsd,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        contextLimit: evt.context?.limit,
        contextUsed: evt.context?.used,
        ...(raw.systemPrompt ? { systemPrompt: raw.systemPrompt } : {}),
      },
    });
  }

  function handleModelCallStarted(
    evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  ) {
    const traceEntry = findTraceForEvent(evt);
    if (!traceEntry) return;
    if (activeGenerations.has(evt.callId)) return;

    // Read content fields from raw event
    const raw = evt as unknown as Record<string, unknown>;
    const generation = traceEntry.trace.generation({
      id: evt.callId,
      name: `Model Call (${evt.model})`,
      model: evt.model,
      startTime: new Date(evt.ts),
      input: raw.inputMessages ?? undefined,
      metadata: {
        provider: evt.provider,
        api: evt.api,
        transport: evt.transport,
        runId: evt.runId,
        ...(raw.systemPrompt ? { systemPrompt: raw.systemPrompt } : {}),
      },
    });

    activeGenerations.set(evt.callId, { generation, startTimeMs: evt.ts });
  }

  function handleModelCallCompleted(
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
  ) {
    const entry = activeGenerations.get(evt.callId);
    if (!entry) return;

    // Read content fields from raw event
    const raw = evt as unknown as Record<string, unknown>;
    entry.generation.end({
      endTime: new Date(evt.ts),
      output: raw.outputMessages ?? undefined,
      metadata: {
        durationMs: evt.durationMs,
        requestPayloadBytes: evt.requestPayloadBytes,
        responseStreamBytes: evt.responseStreamBytes,
        timeToFirstByteMs: evt.timeToFirstByteMs,
      },
    });

    activeGenerations.delete(evt.callId);
  }

  function handleModelCallError(
    evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
  ) {
    const entry = activeGenerations.get(evt.callId);
    if (!entry) return;

    entry.generation.update({
      statusMessage: `${evt.errorCategory}: ${evt.failureKind ?? "unknown"}`,
      metadata: {
        errorCategory: evt.errorCategory,
        failureKind: evt.failureKind,
        durationMs: evt.durationMs,
      },
    });

    entry.generation.end({ endTime: new Date(evt.ts) });
    activeGenerations.delete(evt.callId);
  }

  function handleToolExecutionStarted(
    evt: Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
  ) {
    const traceEntry = findTraceForEvent(evt);
    if (!traceEntry) return;

    const spanId = `${evt.runId}:${evt.toolName}:${evt.ts}`;
    if (activeSpans.has(spanId)) return;

    // Read content fields from raw event
    const raw = evt as unknown as Record<string, unknown>;
    const span = traceEntry.trace.span({
      id: spanId,
      name: `Tool: ${evt.toolName}`,
      startTime: new Date(evt.ts),
      input: raw.toolInput ?? undefined,
      metadata: {
        runId: evt.runId,
        ...(evt.paramsSummary
          ? {
              paramsKind: evt.paramsSummary.kind,
              paramsLength: "length" in evt.paramsSummary ? evt.paramsSummary.length : undefined,
            }
          : {}),
      },
    });

    activeSpans.set(spanId, { span, startTimeMs: evt.ts });
  }

  function handleToolExecutionCompleted(
    evt: Extract<DiagnosticEventPayload, { type: "tool.execution.completed" }>,
  ) {
    const spanEntry = findSpanByRunIdAndTool(evt.runId, evt.toolName);
    if (!spanEntry) return;

    // Read content fields from raw event
    const raw = evt as unknown as Record<string, unknown>;
    spanEntry.span.end({
      endTime: new Date(evt.ts),
      output: raw.toolOutput ?? undefined,
      metadata: { durationMs: evt.durationMs },
    });

    activeSpans.delete(spanEntry.key);
  }

  function handleToolExecutionError(
    evt: Extract<DiagnosticEventPayload, { type: "tool.execution.error" }>,
  ) {
    const spanEntry = findSpanByRunIdAndTool(evt.runId, evt.toolName);
    if (!spanEntry) return;

    spanEntry.span.update({
      statusMessage: evt.errorCategory ?? "error",
      metadata: { errorCategory: evt.errorCategory, durationMs: evt.durationMs },
    });

    spanEntry.span.end({ endTime: new Date(evt.ts) });
    activeSpans.delete(spanEntry.key);
  }

  // --- Helpers ---

  function findTraceForEvent(evt: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
  }): TraceEntry | null {
    if (evt.runId) {
      const entry = activeTraces.get(evt.runId);
      if (entry) return entry;
    }
    // Fallback: first active trace (for events that arrive before run.started)
    for (const [, entry] of activeTraces) {
      return entry;
    }
    return null;
  }

  function findSpanByRunIdAndTool(
    runId: string,
    toolName: string,
  ): { span: SpanEntry["span"]; key: string } | null {
    for (const [key, entry] of activeSpans) {
      if (key.startsWith(`${runId}:${toolName}:`)) {
        return { span: entry.span, key };
      }
    }
    return null;
  }

  // --- Plugin service ---

  return {
    id: "diagnostics-langfuse",
    async start(ctx) {
      await stopStarted();

      const cfg = resolveConfig(ctx.config.diagnostics as Record<string, unknown> | undefined);
      if (!cfg) {
        return;
      }
      activeConfig = cfg;

      client = new Langfuse({
        publicKey: cfg.publicKey,
        secretKey: cfg.secretKey,
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        ...(cfg.flushIntervalMs ? { flushInterval: cfg.flushIntervalMs } : {}),
        ...(cfg.release ? { release: cfg.release } : {}),
      });

      ctx.logger.info("diagnostics-langfuse: Langfuse client initialized");

      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-langfuse: internal diagnostics capability unavailable");
        return;
      }

      unsubscribe = subscribe(
        (evt: DiagnosticEventPayload, _metadata: DiagnosticEventMetadata) => {
          try {
            switch (evt.type) {
              case "run.started":
                handleRunStarted(evt);
                break;
              case "run.completed":
                handleRunCompleted(evt);
                break;
              case "model.usage":
                handleModelUsage(evt);
                break;
              case "model.call.started":
                handleModelCallStarted(evt);
                break;
              case "model.call.completed":
                handleModelCallCompleted(evt);
                break;
              case "model.call.error":
                handleModelCallError(evt);
                break;
              case "tool.execution.started":
                handleToolExecutionStarted(evt);
                break;
              case "tool.execution.completed":
                handleToolExecutionCompleted(evt);
                break;
              case "tool.execution.error":
                handleToolExecutionError(evt);
                break;
            }
          } catch (err) {
            ctx.logger.error(
              `diagnostics-langfuse: event handler failed (${evt.type}): ${formatError(err)}`,
            );
          }
        },
      );
    },
    async stop() {
      await stopStarted();
    },
  };
}
