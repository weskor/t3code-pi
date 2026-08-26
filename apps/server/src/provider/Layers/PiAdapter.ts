/** Provider adapter for Pi using one `pi --mode rpc` process per T3 thread. */
import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  type AgentSessionEvent,
  buildPiTurnCommand,
  extractAssistantTextDelta,
  extractForkMessages,
  extractReasoningTextDelta,
  extractSessionFile,
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  piForkSucceeded,
  piImageContentFromBytes,
  type PiImageContent,
  piResponseHasCommand,
  piResponseSucceeded,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  splitPiModelSlug,
  type PiRpcTransport,
  type PiStdoutMessage,
  type PiThinkingLevel,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "./PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_STATE_TIMEOUT_MS = 5_000;
const PI_COMMANDS_TIMEOUT_MS = 5_000;
const PI_MESSAGES_TIMEOUT_MS = 5_000;
const PI_FORK_TIMEOUT_MS = 15_000;
const PI_MODEL_OPTIONS_TIMEOUT_MS = 5_000;
const PI_APPROVAL_SENTINEL_COMMAND = "t3-approval-gate";

const APPROVAL_EXTENSION_CANDIDATES: ReadonlyArray<string> = (() => {
  const resolve = (relative: string): string | undefined => {
    try {
      return NodeURL.fileURLToPath(new URL(relative, import.meta.url));
    } catch {
      return undefined;
    }
  };
  return [resolve("../assets/pi/t3-approvals.ts"), resolve("./assets/pi/t3-approvals.ts")].filter(
    (value): value is string => value !== undefined,
  );
})();

type PiApprovalGate =
  | { readonly gate: false }
  | { readonly gate: true; readonly mode: "approval-required" | "auto-accept-edits" };

function approvalGateForRuntimeMode(runtimeMode: ProviderSession["runtimeMode"]): PiApprovalGate {
  if (runtimeMode === "full-access") return { gate: false };
  if (runtimeMode === "auto-accept-edits") return { gate: true, mode: "auto-accept-edits" };
  // Pi has no native equivalent of T3's provider-specific `auto` reviewer,
  // so `auto` intentionally falls back to supervised behavior.
  return { gate: true, mode: "approval-required" };
}

interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  readonly args: unknown;
}

interface PiTurnState {
  readonly turnId: TurnId;
  readonly items: Array<PiToolItem>;
}

interface PendingApproval {
  readonly piId: string;
  readonly requestType: CanonicalRequestType;
  readonly sessionApprovalKey: string;
}

interface NumberedOption {
  readonly index: number;
  readonly label: string;
}

interface PendingUserInput {
  readonly piId: string;
  readonly questionId: string;
  readonly method: "select" | "input" | "editor";
  readonly numberedOptions?: ReadonlyArray<NumberedOption>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly sessionScope: Scope.Closeable;
  readonly transport: PiRpcTransport;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionApprovals: Set<string>;
  turnState: PiTurnState | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  stopped: boolean;
  currentModel: string | undefined;
  appliedThinkingLevel: PiThinkingLevel | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export function classifyPiToolItemType(toolName: string): CanonicalItemType {
  const tokens = new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const has = (...words: ReadonlyArray<string>): boolean => words.some((word) => tokens.has(word));
  if (has("mcp")) return "mcp_tool_call";
  if (has("agent", "subagent", "task", "skill")) return "collab_agent_tool_call";
  if (has("bash", "shell", "command", "terminal", "exec")) return "command_execution";
  if (has("edit", "write", "patch", "apply", "file")) return "file_change";
  if (has("search", "web")) return "web_search";
  if (has("image")) return "image_view";
  return "dynamic_tool_call";
}

export function classifyPiApprovalRequestType(toolHint: string): CanonicalRequestType {
  switch (classifyPiToolItemType(toolHint)) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function summarizePiToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const preferred =
    input["command"] ?? input["cmd"] ?? input["file_path"] ?? input["filePath"] ?? input["path"];
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim().slice(0, 400);
  try {
    const serialized = JSON.stringify(input);
    return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

function partialResultText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, 8_000);
  } catch {
    return String(value).slice(0, 8_000);
  }
}

export function parseNumberedList(
  text: string,
): { readonly title: string; readonly items: ReadonlyArray<NumberedOption> } | null {
  const lines = text.split("\n");
  const items: NumberedOption[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d+)\.\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) items.push({ index: Number(match[1]), label: match[2] });
  }
  return items.length >= 2 ? { title: lines[0] ?? text, items } : null;
}

export function buildPiApprovalResponse(
  piId: string,
  decision: ProviderApprovalDecision,
): RpcExtensionUIResponse {
  return {
    type: "extension_ui_response",
    id: piId,
    confirmed:
      decision === "accept" ||
      decision === "acceptForSession" ||
      decision === "acceptAlways",
  };
}

export function buildPiUserInputResponse(
  pending: PendingUserInput,
  answers: ProviderUserInputAnswers,
): RpcExtensionUIResponse {
  const answer = answers[pending.questionId];
  if (pending.method === "input" && pending.numberedOptions) {
    const selected = Array.isArray(answer)
      ? answer.map(String)
      : typeof answer === "string" && answer
        ? [answer]
        : [];
    const indices = selected.flatMap((label) => {
      const option = pending.numberedOptions?.find((candidate) => candidate.label === label);
      return option ? [String(option.index)] : [];
    });
    return { type: "extension_ui_response", id: pending.piId, value: indices.join(",") };
  }
  return {
    type: "extension_ui_response",
    id: pending.piId,
    value: typeof answer === "string" ? answer : "",
  };
}

function readPiResumeState(resumeCursor: unknown): { readonly sessionFile: string } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) return undefined;
  const sessionFile = (resumeCursor as Record<string, unknown>)["sessionFile"];
  return typeof sessionFile === "string" && sessionFile.trim()
    ? { sessionFile: sessionFile.trim() }
    : undefined;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const baseEnvironment = options?.environment ?? process.env;
  const sessions = new Map<ThreadId, PiSessionContext>();
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

  let approvalExtensionPath: string | undefined;
  for (const candidate of APPROVAL_EXTENSION_CANDIDATES) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      approvalExtensionPath = candidate;
      break;
    }
  }

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const stamp = () => Effect.all({ eventId: Effect.map(uuid, EventId.make), createdAt: nowIso });
  const emit = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const openTurn = (context: PiSessionContext): Effect.Effect<TurnId> =>
    Effect.gen(function* () {
      const turnId = TurnId.make(yield* uuid);
      const updatedAt = yield* nowIso;
      context.turnState = { turnId, items: [] };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt,
      };
      yield* emit({
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        type: "turn.started",
        payload: context.currentModel ? { model: context.currentModel } : {},
      });
      return turnId;
    });

  const completeTurn = (
    context: PiSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const active = context.turnState;
      if (!active) return;
      context.turns.push({ id: active.turnId, items: [...active.items] });
      context.turnState = undefined;
      const { activeTurnId: _activeTurnId, ...rest } = context.session;
      context.session = { ...rest, status: "ready", updatedAt: yield* nowIso };
      yield* emit({
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: active.turnId,
        type: "turn.completed",
        payload: { state, ...(errorMessage ? { errorMessage } : {}) },
      });
    });

  const handlePiEvent = (context: PiSessionContext, event: AgentSessionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (event.type === "agent_start") {
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "session.state.changed",
          payload: { state: "running" },
        });
        return;
      }
      if (event.type === "turn_start") {
        if (!context.turnState) yield* openTurn(context);
        return;
      }
      if (event.type === "message_update") {
        const active = context.turnState;
        if (!active) return;
        const assistantText = extractAssistantTextDelta(event);
        const reasoningText = extractReasoningTextDelta(event);
        const delta = assistantText ?? reasoningText;
        if (delta === null) return;
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: active.turnId,
          type: "content.delta",
          payload: {
            streamKind: assistantText !== null ? "assistant_text" : "reasoning_text",
            delta,
          },
        });
        return;
      }
      if (event.type === "tool_execution_start") {
        const active = context.turnState;
        if (!active) return;
        const itemId = RuntimeItemId.make(event.toolCallId);
        const itemType = classifyPiToolItemType(event.toolName);
        active.items.push({ id: itemId, type: itemType, toolName: event.toolName, args: event.args });
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: active.turnId,
          itemId,
          type: "item.started",
          payload: {
            itemType,
            title: event.toolName,
            ...(summarizePiToolArgs(event.args) ? { detail: summarizePiToolArgs(event.args) } : {}),
            data: { toolName: event.toolName, input: event.args },
          },
        });
        return;
      }
      if (event.type === "tool_execution_update") {
        const active = context.turnState;
        const delta = partialResultText(event.partialResult);
        if (!active || !delta) return;
        const itemType = classifyPiToolItemType(event.toolName);
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: active.turnId,
          itemId: RuntimeItemId.make(event.toolCallId),
          type: "content.delta",
          payload: {
            streamKind: itemType === "command_execution" ? "command_output" : "file_change_output",
            delta,
          },
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const active = context.turnState;
        if (!active) return;
        const itemId = RuntimeItemId.make(event.toolCallId);
        const stored = active.items.find((item) => item.id === itemId);
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId: active.turnId,
          itemId,
          type: "item.completed",
          payload: {
            itemType: classifyPiToolItemType(event.toolName),
            title: event.toolName,
            status: event.isError ? "failed" : "completed",
            ...(stored && summarizePiToolArgs(stored.args)
              ? { detail: summarizePiToolArgs(stored.args) }
              : {}),
            data: { toolName: event.toolName, input: stored?.args },
          },
        });
        return;
      }
      if (event.type === "agent_end") {
        if (!event.willRetry && context.turnState) yield* completeTurn(context, "completed");
        return;
      }
      if (event.type === "compaction_start") {
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "session.state.changed",
          payload: { state: "waiting", reason: "compaction" },
        });
        return;
      }
      if (event.type === "compaction_end") {
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "thread.state.changed",
          payload: { state: "compacted" },
        });
      }
    });

  const handleExtensionRequest = (
    context: PiSessionContext,
    request: RpcExtensionUIRequest,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (
        request.method === "notify" ||
        request.method === "setStatus" ||
        request.method === "setWidget" ||
        request.method === "setTitle" ||
        request.method === "set_editor_text"
      ) {
        return;
      }

      const requestId = ApprovalRequestId.make(yield* uuid);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = context.turnState?.turnId;

      if (request.method === "confirm") {
        const requestType = classifyPiApprovalRequestType(request.title);
        const detail = request.message ? `${request.title}\n${request.message}` : request.title;
        const sessionApprovalKey = `${requestType}:${detail}`;
        if (context.sessionApprovals.has(sessionApprovalKey)) {
          yield* context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: request.id,
            confirmed: true,
          });
          return;
        }
        context.pendingApprovals.set(requestId, {
          piId: request.id,
          requestType,
          sessionApprovalKey,
        });
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          requestId: runtimeRequestId,
          type: "request.opened",
          payload: {
            requestType,
            detail: detail.slice(0, 2_000),
            args: request,
            options: [
              { decision: "accept", label: "Allow once" },
              { decision: "acceptForSession", label: "Allow for session" },
              { decision: "decline", label: "Deny" },
            ],
          },
        });
        return;
      }

      const questionId = String(requestId);
      let question: UserInputQuestion;
      let numberedOptions: ReadonlyArray<NumberedOption> | undefined;
      if (request.method === "select") {
        question = {
          id: questionId,
          header: request.title.slice(0, 12) || "Select",
          question: request.title,
          options: request.options.map((label) => ({ label, description: label })),
          multiSelect: false,
        };
      } else {
        const parsed = request.method === "input" ? parseNumberedList(request.title) : null;
        if (parsed) {
          numberedOptions = parsed.items;
          question = {
            id: questionId,
            header: parsed.title.slice(0, 12) || "Select",
            question: parsed.title,
            options: parsed.items.map((item) => ({ label: item.label, description: item.label })),
            multiSelect: true,
          };
        } else {
          question = {
            id: questionId,
            header: request.title.slice(0, 12) || "Input",
            question: request.title || "Input",
            options: [],
            multiSelect: false,
          };
        }
      }
      context.pendingUserInputs.set(requestId, {
        piId: request.id,
        questionId,
        method: request.method,
        ...(numberedOptions ? { numberedOptions } : {}),
      });
      yield* emit({
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        requestId: runtimeRequestId,
        type: "user-input.requested",
        payload: { questions: [question] },
      });
    });

  const handleMessage = (context: PiSessionContext, message: PiStdoutMessage): Effect.Effect<void> => {
    if (message._tag === "event") return handlePiEvent(context, message.event);
    if (message._tag === "extension-ui") return handleExtensionRequest(context, message.request);
    return Effect.void;
  };

  const cancelPendingRequests = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [requestId, pending] of context.pendingApprovals) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            confirmed: false,
          }),
        );
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          type: "request.resolved",
          payload: { requestType: pending.requestType, decision: "cancel" },
        });
      }
      context.pendingApprovals.clear();
      for (const [requestId, pending] of context.pendingUserInputs) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            cancelled: true,
          }),
        );
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      context.pendingUserInputs.clear();
    });

  const stopSessionInternal = (
    context: PiSessionContext,
    emitExit: boolean,
    exitKind: "graceful" | "error" = "graceful",
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      if (context.turnState) yield* completeTurn(context, "interrupted", "Session stopped.");
      yield* cancelPendingRequests(context);
      if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
      yield* Effect.ignore(Scope.close(context.sessionScope, Exit.void));
      const { activeTurnId: _activeTurnId, ...rest } = context.session;
      context.session = { ...rest, status: "closed", updatedAt: yield* nowIso };
      sessions.delete(context.session.threadId);
      if (emitExit) {
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "session.exited",
          payload: {
            reason: exitKind === "error" ? "Pi process exited unexpectedly." : "Session stopped",
            exitKind,
            recoverable: exitKind !== "error",
          },
        });
      }
    });

  const requireSession = (threadId: ThreadId): Effect.Effect<PiSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  const resolvePromptImages = (
    attachments: ProviderSendTurnInput["attachments"],
  ): Effect.Effect<ReadonlyArray<PiImageContent>, ProviderAdapterError> =>
    Effect.forEach(attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!path) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(path).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        return piImageContentFromBytes({ mimeType: attachment.mimeType, bytes });
      }),
    );

  const maybeSwitchModel = (
    context: PiSessionContext,
    requestedModel: string | undefined,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      if (!requestedModel || requestedModel === context.currentModel) return;
      const parsed = splitPiModelSlug(requestedModel);
      if (!parsed) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid Pi model slug '${requestedModel}'; expected 'provider/id'.`,
        });
      }
      const response = yield* context.transport.request(
        { type: "set_model", provider: parsed.provider, modelId: parsed.id },
        `pi-set-model-${yield* uuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "set_model")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `Pi rejected model switch to '${requestedModel}'.`,
        });
      }
      context.currentModel = requestedModel;
      context.appliedThinkingLevel = undefined;
      context.session = { ...context.session, model: requestedModel };
    });

  const applyThinkingLevel = (
    context: PiSessionContext,
    selection: ModelSelection | null | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const level = resolvePiThinkingLevel(selection);
      if (!level || level === context.appliedThinkingLevel) return;
      const response = yield* context.transport.request(
        { type: "set_thinking_level", level },
        `pi-set-thinking-${yield* uuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (piResponseSucceeded(response, "set_thinking_level")) {
        context.appliedThinkingLevel = level;
      } else {
        yield* Effect.logWarning("pi.thinking.set-failed", {
          threadId: context.session.threadId,
          level,
        });
      }
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "PiAdapter.startSession",
  )(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }
    if (input.providerInstanceId !== undefined && input.providerInstanceId !== boundInstanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider instance '${boundInstanceId}' but received '${input.providerInstanceId}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) yield* stopSessionInternal(existing, false).pipe(Effect.ignore);

    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const resume = readPiResumeState(input.resumeCursor);
    const cwd = input.cwd ?? serverConfig.cwd;
    const thinking = resolvePiThinkingLevel(modelSelection);
    const args: string[] = ["--mode", "rpc"];
    if (resume) args.push("--session", resume.sessionFile);
    if (modelSelection?.model) args.push("--model", modelSelection.model);
    if (thinking) args.push("--thinking", thinking);

    const gate = approvalGateForRuntimeMode(input.runtimeMode);
    let environment = baseEnvironment;
    if (gate.gate) {
      if (!approvalExtensionPath) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Pi approval mode requires the bundled T3 approval extension, but it is unavailable.",
        });
      }
      args.push("--extension", approvalExtensionPath);
      environment = { ...baseEnvironment, T3_PI_APPROVAL_MODE: gate.mode };
    }

    const sessionScope = yield* Scope.make();
    const makeTransport = options?.makeTransport ?? makePiRpcTransport;
    const transport = yield* makeTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args,
      cwd,
      env: environment,
      onExit: Effect.suspend(() => {
        const live = sessions.get(input.threadId);
        return live && !live.stopped ? stopSessionInternal(live, true, "error") : Effect.void;
      }),
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "Failed to start Pi RPC process.",
            cause,
          }),
      ),
      Effect.onError(() => Effect.ignore(Scope.close(sessionScope, Exit.void))),
    );

    const startedAt = yield* nowIso;
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const context: PiSessionContext = {
      session,
      sessionScope,
      transport,
      notificationFiber: undefined,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      sessionApprovals: new Set(),
      turnState: undefined,
      turns: [],
      stopped: false,
      currentModel: modelSelection?.model,
      appliedThinkingLevel: thinking,
    };
    sessions.set(input.threadId, context);

    context.notificationFiber = yield* Stream.fromQueue(transport.messages).pipe(
      Stream.mapEffect((message) => handleMessage(context, message)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logError("pi.runtime.message-failed", { threadId: input.threadId, cause }),
      ),
      Effect.forkIn(sessionScope),
    );

    const stateResponse = yield* transport.request(
      { type: "get_state" },
      `pi-get-state-${yield* uuid}`,
      PI_STATE_TIMEOUT_MS,
    );
    const sessionFile = extractSessionFile(stateResponse);
    if (sessionFile) context.session = { ...context.session, resumeCursor: { sessionFile } };

    if (gate.gate) {
      const commands = yield* transport.request(
        { type: "get_commands" },
        `pi-get-commands-${yield* uuid}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      if (!piResponseHasCommand(commands, PI_APPROVAL_SENTINEL_COMMAND)) {
        yield* stopSessionInternal(context, false);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Pi approval extension failed its load handshake; refusing to continue ungated.",
        });
      }
    }

    yield* emit({
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      type: "session.started",
      payload: sessionFile ? { resume: { sessionFile } } : {},
    });
    if (sessionFile) {
      yield* emit({
        ...(yield* stamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        type: "thread.started",
        payload: { providerThreadId: sessionFile },
      });
    }
    yield* emit({
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      type: "session.configured",
      payload: {
        config: {
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          cwd,
        },
      },
    });
    yield* emit({
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      type: "session.state.changed",
      payload: { state: "ready" },
    });
    return { ...context.session };
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
    "PiAdapter.sendTurn",
  )(function* (input) {
    const context = yield* requireSession(input.threadId);
    const images = yield* resolvePromptImages(input.attachments);
    const prompt = input.input ?? "";
    if (!prompt && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require text or at least one image attachment.",
      });
    }
    const isMidTurn = context.turnState !== undefined;
    if (!isMidTurn) {
      const requestedModel =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
      yield* maybeSwitchModel(context, requestedModel);
      yield* applyThinkingLevel(context, input.modelSelection);
    }
    const turnId = context.turnState?.turnId ?? (yield* openTurn(context));
    yield* context.transport.writeCommand(
      buildPiTurnCommand({ isMidTurn, message: prompt, images }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: isMidTurn ? "steer" : "prompt",
            detail: "Failed to write request to Pi.",
            cause,
          }),
      ),
    );
    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
    "PiAdapter.interruptTurn",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
    yield* cancelPendingRequests(context);
    if (context.turnState) yield* completeTurn(context, "interrupted", "Turn interrupted.");
  });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = Effect.fn(
    "PiAdapter.respondToRequest",
  )(function* (threadId, requestId, decision) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `Unknown Pi approval request '${requestId}'.`,
      });
    }
    context.pendingApprovals.delete(requestId);
    yield* context.transport.writeExtensionResponse(buildPiApprovalResponse(pending.piId, decision));
    if (decision === "acceptForSession" || decision === "acceptAlways") {
      context.sessionApprovals.add(pending.sessionApprovalKey);
    }
    yield* emit({
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      requestId: RuntimeRequestId.make(requestId),
      type: "request.resolved",
      payload: { requestType: pending.requestType, decision },
    });
  });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = Effect.fn(
    "PiAdapter.respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: `Unknown Pi input request '${requestId}'.`,
      });
    }
    context.pendingUserInputs.delete(requestId);
    yield* context.transport.writeExtensionResponse(buildPiUserInputResponse(pending, answers));
    yield* emit({
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      requestId: RuntimeRequestId.make(requestId),
      type: "user-input.resolved",
      payload: { answers },
    });
  });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = Effect.fn(
    "PiAdapter.readThread",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    };
  });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
    "PiAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    const context = yield* requireSession(threadId);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }
    if (context.turnState) {
      yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
      yield* cancelPendingRequests(context);
      yield* completeTurn(context, "interrupted", "Turn interrupted for rollback.");
    }
    const forkMessages = yield* context.transport.request(
      { type: "get_fork_messages" },
      `pi-fork-messages-${yield* uuid}`,
      PI_MESSAGES_TIMEOUT_MS,
    );
    if (!piResponseSucceeded(forkMessages, "get_fork_messages")) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_fork_messages",
        detail: "Pi did not return rollback history.",
      });
    }
    const target = resolveForkTargetEntryId(extractForkMessages(forkMessages), numTurns);
    if (target) {
      const response =
        target.kind === "fork"
          ? yield* context.transport.request(
              { type: "fork", entryId: target.entryId },
              `pi-fork-${yield* uuid}`,
              PI_FORK_TIMEOUT_MS,
            )
          : yield* context.transport.request(
              { type: "new_session" },
              `pi-new-session-${yield* uuid}`,
              PI_FORK_TIMEOUT_MS,
            );
      if (!piForkSucceeded(response)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: target.kind === "fork" ? "fork" : "new_session",
          detail: "Pi rejected or cancelled rollback.",
        });
      }
      const state = yield* context.transport.request(
        { type: "get_state" },
        `pi-get-state-${yield* uuid}`,
        PI_STATE_TIMEOUT_MS,
      );
      const sessionFile = extractSessionFile(state);
      if (sessionFile) {
        context.session = {
          ...context.session,
          status: "ready",
          updatedAt: yield* nowIso,
          resumeCursor: { sessionFile },
        };
        yield* emit({
          ...(yield* stamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          type: "thread.started",
          payload: { providerThreadId: sessionFile },
        });
      }
    }
    context.turns.splice(Math.max(0, context.turns.length - numTurns));
    return yield* readThread(threadId);
  });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
    "PiAdapter.stopSession",
  )(function* (threadId) {
    yield* stopSessionInternal(yield* requireSession(threadId), true);
  });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => stopSessionInternal(context, true),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => stopSessionInternal(context, false),
      { discard: true },
    ).pipe(Effect.andThen(Queue.shutdown(runtimeEvents))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
