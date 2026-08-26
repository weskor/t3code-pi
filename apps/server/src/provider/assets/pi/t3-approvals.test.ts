import { describe, expect, it } from "@effect/vitest";

import { shouldAutoApprove } from "./t3-approvals.ts";

describe("Pi T3 approval gate", () => {
  it("always allows read-only tools", () => {
    expect(shouldAutoApprove("read", "approval-required")).toBe(true);
    expect(shouldAutoApprove("grep", "auto-accept-edits")).toBe(true);
  });

  it("only auto-allows edits in auto-accept-edits mode", () => {
    expect(shouldAutoApprove("edit", "approval-required")).toBe(false);
    expect(shouldAutoApprove("apply_patch", "auto-accept-edits")).toBe(true);
  });

  it("never auto-allows shell commands", () => {
    expect(shouldAutoApprove("bash", "approval-required")).toBe(false);
    expect(shouldAutoApprove("bash", "auto-accept-edits")).toBe(false);
  });
});
