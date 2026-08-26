/** Typed JSONL transport for `pi --mode rpc` without linking Pi into T3. */
import type { ModelCapabilities, ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

export interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RpcCommand =
  | { readonly id?: string; readonly type: "prompt"; readonly message: string; readonly images?: PiImageContent[] }
  | { readonly id?: string; readonly type: "steer"; readonly message: string; readonly images?: PiImageContent[] }
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "new_session" }
  | { readonly id?: string; readonly type: "get_state" }
  | { readonly id?: string; readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly id?: string; readonly type: "get_available_models" }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly id?: string; readonly type: "get_fork_messages" }
  | { readonly id?: string; readonly type: "fork"; readonly entryId: string }
  | { readonly id?: string; readonly type: "get_last_assistant_text" }
  | { readonly id?: string; readonly type: "get_commands" };

export type RpcResponse =
  | {
      readonly id?: string;
      readonly type: "response";
      readonly command: string;
      readonly success: true;
      readonly data?: unknown;
    }
  | {
      readonly id?: string;
      readonly type: "response";
      readonly command: string;
      readonly success: false;
      readonly error: string;
    };

export type RpcExtensionUIRequest =
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "select"; readonly title: string; readonly options: string[] }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "confirm"; readonly title: string; readonly message: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "input"; readonly title: string; readonly placeholder?: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "editor"; readonly title: string; readonly prefill?: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "notify"; readonly message: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setStatus"; readonly statusKey: string; readonly statusText?: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setWidget"; readonly widgetKey: string; readonly widgetLines?: string[] }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "setTitle"; readonly title: string }
  | { readonly type: "extension_ui_request"; readonly id: string; readonly method: "set_editor_text"; readonly text: string };

export type RpcExtensionUIResponse =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
}

type AssistantMessageEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly delta: string }
  | { readonly type: string; readonly delta?: unknown };

export type AgentSessionEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | { readonly type: "message_update"; readonly assistantMessageEvent?: AssistantMessageEvent }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string; readonly toolName: string; readonly partialResult?: unknown }
  | { readonly type: "tool_execution_end"; readonly toolCallId: string; readonly toolName: string; readonly isError?: boolean }
  | { readonly type: "agent_end"; readonly willRetry?: boolean }
  | { readonly type: "compaction_start" }
  | { readonly type: "compaction_end" };

export type PiStdoutMessage =
  | { readonly _tag: "response"; readonly id: string | undefined; readonly response: RpcResponse }
  | { readonly _tag: "extension-ui"; readonly request: RpcExtensionUIRequest }
  | { readonly _tag: "event"; readonly event: AgentSessionEvent };

export function tryParsePiJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    // eslint-disable-next-line no-restricted-syntax -- untrusted JSONL boundary
    const value = JSON.parse(trimmed) as unknown; // @effect-diagnostics-ignore preferSchemaOverJson
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function classifyPiStdoutMessage(msg: Record<string, unknown>): PiStdoutMessage | null {
  const type = msg["type"];
  if (type === "response") {
    return {
      _tag: "response",
      id: typeof msg["id"] === "string" ? msg["id"] : undefined,
      response: msg as unknown as RpcResponse,
    };
  }
  if (type === "extension_ui_request") {
    if (typeof msg["id"] !== "string" || typeof msg["method"] !== "string") return null;
    return { _tag: "extension-ui", request: msg as unknown as RpcExtensionUIRequest };
  }
  if (typeof type === "string" && type.length > 0) {
    return { _tag: "event", event: msg as unknown as AgentSessionEvent };
  }
  return null;
}

export function parsePiStdoutLine(line: string): PiStdoutMessage | null {
  const msg = tryParsePiJsonObject(line);
  return msg ? classifyPiStdoutMessage(msg) : null;
}

export function extractAssistantTextDelta(event: AgentSessionEvent): string | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent;
  return update?.type === "text_delta" && typeof update.delta === "string" ? update.delta : null;
}

export function extractReasoningTextDelta(event: AgentSessionEvent): string | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent;
  return update?.type === "thinking_delta" && typeof update.delta === "string" ? update.delta : null;
}

export function splitPiModelSlug(slug: string): { provider: string; id: string } | null {
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}

export const piModelSlug = (model: Pick<ModelInfo, "provider" | "id">): string =>
  `${model.provider}/${model.id}`;

export function piImageContentFromBytes(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): PiImageContent {
  return {
    type: "image",
    data: Buffer.from(input.bytes).toString("base64"),
    mimeType: input.mimeType,
  };
}

export function buildPiTurnCommand(input: {
  readonly isMidTurn: boolean;
  readonly message: string;
  readonly images?: ReadonlyArray<PiImageContent>;
}): RpcCommand {
  const images = input.images?.length ? [...input.images] : undefined;
  return input.isMidTurn
    ? { type: "steer", message: input.message, ...(images ? { images } : {}) }
    : { type: "prompt", message: input.message, ...(images ? { images } : {}) };
}

const PI_THINKING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

export const PI_THINKING_OPTION_ID = "thinking";
const PI_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS.map((item) => item.value));

export function resolvePiThinkingLevel(
  modelSelection: ModelSelection | null | undefined,
): PiThinkingLevel | undefined {
  const value = getModelSelectionStringOptionValue(modelSelection, PI_THINKING_OPTION_ID);
  return value !== undefined && PI_THINKING_LEVEL_SET.has(value) ? (value as PiThinkingLevel) : undefined;
}

export function piModelCapabilities(model: Pick<ModelInfo, "provider" | "id" | "reasoning">): ModelCapabilities {
  if (!model.reasoning) return createModelCapabilities({ optionDescriptors: [] });
  const supportsExtraHigh = model.provider === "openai" && model.id === "codex-max";
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: PI_THINKING_OPTION_ID,
        label: "Thinking",
        options: PI_THINKING_LEVELS.filter(
          (level) => level.value !== "xhigh" || supportsExtraHigh,
        ).map((level) => ({ ...level })),
      }),
    ],
  });
}

export function piModelInfoToServerModel(model: ModelInfo, isDefault = false): ServerProviderModel {
  return {
    slug: piModelSlug(model),
    name: model.name?.trim() || model.id,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities: piModelCapabilities(model),
  };
}

function responseData(response: RpcResponse | undefined): Record<string, unknown> | null {
  if (!response || !response.success || response.data === null || typeof response.data !== "object") return null;
  return response.data as Record<string, unknown>;
}

export function extractSessionFile(response: RpcResponse | undefined): string | undefined {
  const sessionFile = responseData(response)?.["sessionFile"];
  return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile.trim() : undefined;
}

export function extractAvailableModels(response: RpcResponse | undefined): ReadonlyArray<ModelInfo> {
  const models = responseData(response)?.["models"];
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const model = entry as Record<string, unknown>;
    if (typeof model["provider"] !== "string" || typeof model["id"] !== "string") return [];
    return [
      {
        provider: model["provider"],
        id: model["id"],
        ...(typeof model["name"] === "string" ? { name: model["name"] } : {}),
        ...(typeof model["reasoning"] === "boolean" ? { reasoning: model["reasoning"] } : {}),
      },
    ];
  });
}

export function piResponseHasCommand(response: RpcResponse | undefined, commandName: string): boolean {
  const commands = responseData(response)?.["commands"];
  return Array.isArray(commands) && commands.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as Record<string, unknown>)["name"] === commandName;
  });
}

export function extractLastAssistantText(response: RpcResponse | undefined): string | null {
  const text = responseData(response)?.["text"];
  return typeof text === "string" ? text : null;
}

export function piResponseSucceeded(response: RpcResponse | undefined, command: string): boolean {
  return response?.success === true && response.command === command;
}

export function extractForkMessages(
  response: RpcResponse | undefined,
): ReadonlyArray<{ readonly entryId: string; readonly text: string }> {
  const messages = responseData(response)?.["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record["entryId"] !== "string") return [];
    return [{ entryId: record["entryId"], text: typeof record["text"] === "string" ? record["text"] : "" }];
  });
}

export function resolveForkTargetEntryId(
  userMessages: ReadonlyArray<{ readonly entryId: string }>,
  numTurns: number,
): { readonly kind: "fork"; readonly entryId: string } | { readonly kind: "reset" } | null {
  if (numTurns <= 0 || userMessages.length === 0) return null;
  const targetIndex = userMessages.length - numTurns;
  if (targetIndex <= 0) return { kind: "reset" };
  return { kind: "fork", entryId: userMessages[targetIndex]!.entryId };
}

export function piForkSucceeded(response: RpcResponse | undefined): boolean {
  return response?.success === true && responseData(response)?.["cancelled"] !== true;
}

export interface PiRpcTransport {
  readonly writeCommand: (command: RpcCommand) => Effect.Effect<void>;
  readonly writeExtensionResponse: (response: RpcExtensionUIResponse) => Effect.Effect<void>;
  readonly request: (command: RpcCommand, id: string, timeoutMs: number) => Effect.Effect<RpcResponse | undefined>;
  readonly messages: Queue.Dequeue<PiStdoutMessage>;
  readonly kill: Effect.Effect<void>;
}

export interface MakePiRpcTransportOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onExit: Effect.Effect<void>;
}

export const makePiRpcTransport = (options: MakePiRpcTransportOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath || "pi", options.args, {
      env: options.env,
      extendEnv: true,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        shell: spawnCommand.shell,
        forceKillAfter: 5000,
      }),
    );

    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const messages = yield* Queue.unbounded<PiStdoutMessage>();
    const pending = new Map<string, Deferred.Deferred<RpcResponse>>();
    const closed = yield* Deferred.make<void>();

    const writeLine = (value: RpcCommand | RpcExtensionUIResponse): Effect.Effect<void> =>
      Queue.offer(outgoing, Buffer.from(`${JSON.stringify(value)}\n`)).pipe(Effect.asVoid);

    const handleLine = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = parsePiStdoutLine(line);
        if (!message) return;
        if (message._tag === "response") {
          if (message.id) {
            const deferred = pending.get(message.id);
            if (deferred) {
              pending.delete(message.id);
              yield* Deferred.succeed(deferred, message.response);
            }
          }
          return;
        }
        yield* Queue.offer(messages, message);
      });

    const onExit = Deferred.succeed(closed, undefined).pipe(
      Effect.andThen(Queue.shutdown(messages)),
      Effect.andThen(Effect.sync(() => pending.clear())),
      Effect.andThen(options.onExit),
    );

    yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.ignore, Effect.forkScoped);
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(handleLine),
      Effect.ignore,
      Effect.ensuring(onExit),
      Effect.forkScoped,
    );

    const request = (
      command: RpcCommand,
      id: string,
      timeoutMs: number,
    ): Effect.Effect<RpcResponse | undefined> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<RpcResponse>();
        pending.set(id, deferred);
        yield* writeLine({ ...command, id });
        const outcome = yield* Deferred.await(deferred).pipe(
          Effect.map(Option.some),
          Effect.race(Deferred.await(closed).pipe(Effect.as(Option.none<RpcResponse>()))),
          Effect.timeoutOption(timeoutMs),
        );
        pending.delete(id);
        return outcome._tag === "None" ? undefined : Option.getOrUndefined(outcome.value);
      });

    return {
      writeCommand: writeLine,
      writeExtensionResponse: writeLine,
      request,
      messages,
      kill: child.kill().pipe(Effect.ignore),
    } satisfies PiRpcTransport;
  });
