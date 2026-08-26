import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  extractAvailableModels,
  extractAssistantTextDelta,
  parsePiStdoutLine,
  piModelInfoToServerModel,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  splitPiModelSlug,
} from "./PiRpcClient.ts";

describe("PiRpcClient", () => {
  it("classifies response, extension UI, and agent events", () => {
    expect(parsePiStdoutLine('{"type":"response","id":"1","command":"get_state","success":true}')).toMatchObject({
      _tag: "response",
      id: "1",
    });
    expect(
      parsePiStdoutLine(
        '{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"bash","message":"echo hi"}',
      ),
    ).toMatchObject({ _tag: "extension-ui" });
    expect(parsePiStdoutLine('{"type":"turn_start"}')).toMatchObject({ _tag: "event" });
    expect(parsePiStdoutLine("not-json")).toBeNull();
  });

  it("extracts assistant text deltas only", () => {
    expect(
      extractAssistantTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toBe("hello");
    expect(
      extractAssistantTextDelta({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
      }),
    ).toBeNull();
  });

  it("parses provider-qualified Pi model slugs", () => {
    expect(splitPiModelSlug("openai/gpt-5.6-sol")).toEqual({
      provider: "openai",
      id: "gpt-5.6-sol",
    });
    expect(splitPiModelSlug("missing-provider")).toBeNull();
  });

  it("maps live Pi models into T3 models", () => {
    const response = {
      type: "response" as const,
      command: "get_available_models",
      success: true as const,
      data: {
        models: [
          { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
          { provider: "anthropic", id: "claude-sonnet-5", reasoning: false },
        ],
      },
    };
    const models = extractAvailableModels(response);
    expect(models).toHaveLength(2);
    expect(piModelInfoToServerModel(models[0]!, true)).toMatchObject({
      slug: "openai/gpt-5.6-sol",
      isDefault: true,
    });
  });

  it("resolves thinking from generic model options", () => {
    expect(
      resolvePiThinkingLevel({
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai/gpt-5.6-sol",
        options: [{ id: "thinking", value: "high" }],
      }),
    ).toBe("high");
  });

  it("resolves rollback targets without rewinding past the first user message", () => {
    const history = [{ entryId: "a" }, { entryId: "b" }, { entryId: "c" }];
    expect(resolveForkTargetEntryId(history, 1)).toEqual({ kind: "fork", entryId: "c" });
    expect(resolveForkTargetEntryId(history, 2)).toEqual({ kind: "fork", entryId: "b" });
    expect(resolveForkTargetEntryId(history, 3)).toEqual({ kind: "reset" });
  });
});
