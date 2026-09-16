import { describe, expect, it, vi } from "vitest";
import {
  buildStartupStateFailureCopy,
  extractStartupFailureText,
  OPERATOR_STATE_DIR_DISPLAY,
  runStartupStateFailureDialog,
  sanitizeTechnicalErrorFragment,
  SUPPORT_EMAIL,
} from "../src/main/junto/state/startup-state-failure-dialog";
import { PRODUCT_NAME } from "../src/shared/product-name";

describe("extractStartupFailureText", () => {
  it("prefers StateEngineError operation + message", () => {
    expect(
      extractStartupFailureText({
        _tag: "StateEngineError",
        operation: "open",
        message: "state schema identity mismatch (table missing)",
      }),
    ).toBe("state open: state schema identity mismatch (table missing)");
  });

  it("uses Error.message first line only", () => {
    const error = new Error("disk full\n    at open (engine.ts:1)");
    expect(extractStartupFailureText(error)).toBe("disk full");
  });

  it("handles plain strings and empty", () => {
    expect(extractStartupFailureText("  boom  ")).toBe("boom");
    expect(extractStartupFailureText(null)).toBe("unknown error");
  });
});

describe("sanitizeTechnicalErrorFragment", () => {
  it("collapses whitespace and truncates long dumps", () => {
    const long = `line1\nline2 ${"x".repeat(400)}`;
    const out = sanitizeTechnicalErrorFragment(long);
    expect(out).not.toMatch(/\n/u);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts bearer/token/password values", () => {
    expect(
      sanitizeTechnicalErrorFragment("failed token=supersecretvalue password: hunter2"),
    ).toMatch(/token=\[redacted\]/i);
    expect(
      sanitizeTechnicalErrorFragment("failed token=supersecretvalue password: hunter2"),
    ).toMatch(/password=\[redacted\]/i);
    expect(sanitizeTechnicalErrorFragment("Authorization: Bearer abc.def.ghi")).toMatch(
      /\[redacted/i,
    );
  });

  it("returns unavailable for empty input", () => {
    expect(sanitizeTechnicalErrorFragment("   ")).toBe("unavailable");
  });
});

describe("buildStartupStateFailureCopy", () => {
  it("uses customer-facing hierarchy without developer jargon in title/message", () => {
    const copy = buildStartupStateFailureCopy({
      error: {
        _tag: "StateEngineError",
        operation: "open",
        message: "state schema identity mismatch",
      },
    });

    expect(copy.title).toBe("Could not start");
    expect(copy.message).toBe(`${PRODUCT_NAME} could not open its data store`);
    expect(copy.title).not.toMatch(/fatal|error|stateengine|pragma|user_version/i);
    expect(copy.message).not.toMatch(/stateengine|pragma|user_version|schema/i);

    expect(copy.detail).toContain(OPERATOR_STATE_DIR_DISPLAY);
    expect(copy.detail).toContain(SUPPORT_EMAIL);
    expect(copy.detail).toMatch(/was not deleted/i);
    expect(copy.detail).toMatch(/Technical:/);
    expect(copy.detail).toContain("state schema identity mismatch");
  });

  it("accepts a custom state dir display for tests", () => {
    const copy = buildStartupStateFailureCopy({
      error: new Error("permission denied"),
      stateDirDisplay: "/tmp/fake-state/",
    });
    expect(copy.detail).toContain("/tmp/fake-state/");
    expect(copy.detail).not.toContain(OPERATOR_STATE_DIR_DISPLAY);
  });
});

describe("runStartupStateFailureDialog", () => {
  it("quits headless without dialog", async () => {
    const showMessageBox = vi.fn();
    const outcome = await runStartupStateFailureDialog({
      error: new Error("ENOENT"),
      headless: true,
      dialog: { showMessageBox },
    });
    expect(outcome).toEqual({
      action: "quit",
      reason: "startup-state-failure-headless",
    });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it("shows error dialog with Quit only in GUI", async () => {
    const boxes: Array<{
      type: string;
      title: string;
      message: string;
      detail: string;
      buttons: readonly string[];
    }> = [];
    const outcome = await runStartupStateFailureDialog({
      error: {
        _tag: "StateEngineError",
        operation: "open",
        message: "state path is not a real directory",
      },
      headless: false,
      dialog: {
        showMessageBox: async (options) => {
          boxes.push({
            type: options.type,
            title: options.title,
            message: options.message,
            detail: options.detail,
            buttons: options.buttons,
          });
          return { response: 0 };
        },
      },
    });

    expect(outcome).toEqual({
      action: "quit",
      reason: "startup-state-failure",
    });
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(box.type).toBe("error");
    expect(box.buttons).toEqual(["Quit"]);
    expect(box.title).toBe("Could not start");
    expect(box.message).toBe(`${PRODUCT_NAME} could not open its data store`);
    expect(box.detail).toContain(OPERATOR_STATE_DIR_DISPLAY);
    expect(box.detail).toContain(SUPPORT_EMAIL);
    expect(box.detail).not.toMatch(/reset|wipe|delete.*data|format/i);
    // Title/message stay free of schema internals; detail may carry the technical fragment.
    expect(box.title).not.toMatch(/schema|user_version|PRAGMA|StateEngine/i);
    expect(box.message).not.toMatch(/schema|user_version|PRAGMA|StateEngine/i);
  });
});
