// Default-deny approval gate injected into `pi --mode rpc` for non-full-access threads.
// Kept structurally typed so T3 does not depend on Pi's npm package at build time.

interface ToolCallEventLike {
  readonly toolName: string;
  readonly input?: Record<string, unknown>;
}

interface ExtensionContextLike {
  readonly hasUI: boolean;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface ExtensionApiLike {
  registerCommand(
    name: string,
    command: {
      readonly description: string;
      readonly handler: () => Promise<void> | void;
    },
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEventLike,
      context: ExtensionContextLike,
    ) => Promise<{ readonly block: true; readonly reason: string } | undefined>,
  ): void;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);
const EDIT_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);
const SENTINEL_COMMAND = "t3-approval-gate";
const DENIED_REASON = "Denied in T3 Code";

function shouldAutoApprove(toolName: string, mode: string | undefined): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  return mode === "auto-accept-edits" && EDIT_TOOLS.has(toolName);
}

function describeToolCall(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return toolName;
  const preferred = input["command"] ?? input["cmd"] ?? input["file_path"] ?? input["filePath"] ?? input["path"];
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim().slice(0, 500);
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return toolName;
  }
}

export default function t3Approvals(pi: ExtensionApiLike): void {
  pi.registerCommand(SENTINEL_COMMAND, {
    description: "T3 Code approval gate (active)",
    handler: async () => {},
  });

  const mode = process.env["T3_PI_APPROVAL_MODE"];
  pi.on("tool_call", async (event, context) => {
    if (shouldAutoApprove(event.toolName, mode)) return undefined;
    if (!context.hasUI) return { block: true, reason: DENIED_REASON };

    const confirmed = await context.ui.confirm(
      event.toolName,
      describeToolCall(event.toolName, event.input),
    );
    return confirmed ? undefined : { block: true, reason: DENIED_REASON };
  });
}

export { describeToolCall, shouldAutoApprove };
