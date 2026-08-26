import { describe, expect, it } from "@effect/vitest";

import {
  buildPiApprovalResponse,
  buildPiUserInputResponse,
  classifyPiApprovalRequestType,
  classifyPiToolItemType,
  parseNumberedList,
} from "./PiAdapter.ts";

describe("PiAdapter helpers", () => {
  it("maps common Pi tools into canonical T3 item types", () => {
    expect(classifyPiToolItemType("bash")).toBe("command_execution");
    expect(classifyPiToolItemType("apply_patch")).toBe("file_change");
    expect(classifyPiToolItemType("mcp.search")) .toBe("mcp_tool_call");
    expect(classifyPiToolItemType("subagent_task")).toBe("collab_agent_tool_call");
    expect(classifyPiToolItemType("custom_tool")).toBe("dynamic_tool_call");
  });

  it("maps confirmation hints to approval request types", () => {
    expect(classifyPiApprovalRequestType("bash")).toBe("command_execution_approval");
    expect(classifyPiApprovalRequestType("edit file")).toBe("file_change_approval");
    expect(classifyPiApprovalRequestType("custom tool")).toBe("dynamic_tool_call");
  });

  it("maps T3 approval decisions back to Pi confirmations", () => {
    expect(buildPiApprovalResponse("ui-1", "accept")).toEqual({
      type: "extension_ui_response",
      id: "ui-1",
      confirmed: true,
    });
    expect(buildPiApprovalResponse("ui-1", "decline")).toMatchObject({ confirmed: false });
  });

  it("recognizes Pi's numbered-list multiselect convention", () => {
    expect(parseNumberedList("Pick checks\n1. Unit\n2. Typecheck\n3. Lint")).toEqual({
      title: "Pick checks",
      items: [
        { index: 1, label: "Unit" },
        { index: 2, label: "Typecheck" },
        { index: 3, label: "Lint" },
      ],
    });
  });

  it("maps selected labels back to Pi's comma-separated indices", () => {
    expect(
      buildPiUserInputResponse(
        {
          piId: "ui-2",
          questionId: "checks",
          method: "input",
          numberedOptions: [
            { index: 1, label: "Unit" },
            { index: 2, label: "Typecheck" },
            { index: 3, label: "Lint" },
          ],
        },
        { checks: ["Unit", "Lint"] },
      ),
    ).toEqual({
      type: "extension_ui_response",
      id: "ui-2",
      value: "1,3",
    });
  });
});
