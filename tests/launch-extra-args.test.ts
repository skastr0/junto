import { describe, expect, it } from "vitest";
import {
  argvWithoutExtraArgs,
  formatExtraArgs,
  parseExtraArgsText,
  parseHelpFlags,
  reservedLaunchFlags,
  sanitizeExtraArgs,
} from "../src/shared/launch-extra-args";

describe("parseExtraArgsText / formatExtraArgs", () => {
  it("splits on whitespace and keeps quoted groups whole", () => {
    expect(parseExtraArgsText(`--add-dir "/tmp/my dir" -c 'a="b c"' --flag`)).toEqual([
      "--add-dir",
      "/tmp/my dir",
      "-c",
      'a="b c"',
      "--flag",
    ]);
  });

  it("keeps an empty quoted token and performs no expansion", () => {
    expect(parseExtraArgsText(`--name "" $HOME ~`)).toEqual(["--name", "", "$HOME", "~"]);
  });

  it("round-trips through the editable line", () => {
    const args = ["--add-dir", "/tmp/my dir", "-c", 'key="v"', "--plain"];
    expect(parseExtraArgsText(formatExtraArgs(args))).toEqual(args);
  });
});

describe("sanitizeExtraArgs", () => {
  it("keeps the operator's tokens in order", () => {
    const out = sanitizeExtraArgs("claude", ["--dangerously-skip-permissions", "--add-dir", "/tmp/x"]);
    expect(out.args).toEqual(["--dangerously-skip-permissions", "--add-dir", "/tmp/x"]);
    expect(out.rejected).toEqual([]);
  });

  it("refuses a template-owned flag together with its value", () => {
    const out = sanitizeExtraArgs("claude", ["--model", "opus", "--verbose", "--permission-mode=plan"]);
    expect(out.args).toEqual(["--verbose"]);
    expect(out.rejected.map((item) => item.token)).toEqual(["--model", "--permission-mode=plan"]);
  });

  it("refuses the flags that carry the seat's session", () => {
    const reserved = reservedLaunchFlags("claude");
    expect(reserved.has("--session-id")).toBe(true);
    const out = sanitizeExtraArgs("claude", ["--session-id", "x", "--resume", "abc"]);
    expect(out.args).toEqual([]);
    expect(out.rejected).toHaveLength(2);
  });

  it("leaves a harness's own instructions flag to the operator", () => {
    // Junto sends nothing at session start, so these flags are not its own.
    expect(reservedLaunchFlags("claude").has("--append-system-prompt")).toBe(false);
    const out = sanitizeExtraArgs("claude", ["--append-system-prompt", "be brief"]);
    expect(out.args).toEqual(["--append-system-prompt", "be brief"]);
    expect(out.rejected).toEqual([]);
  });

  it("refuses id-less latest-session flags and a bare option terminator", () => {
    const out = sanitizeExtraArgs("devin", ["--continue", "--", "--export"]);
    expect(out.args).toEqual(["--export"]);
    expect(out.rejected.map((item) => item.token)).toEqual(["--continue", "--"]);
  });

  it("leaves Codex `-c` open: effort rides it, and so do operator overrides", () => {
    const out = sanitizeExtraArgs("codex", ["-c", "sandbox_mode=\"danger-full-access\""]);
    expect(out.args).toEqual(["-c", "sandbox_mode=\"danger-full-access\""]);
  });

  it("drops blanks and control characters", () => {
    expect(sanitizeExtraArgs("claude", ["  ", "--ver\u0000bose"]).args).toEqual(["--verbose"]);
  });
});

describe("argvWithoutExtraArgs", () => {
  it("removes the seat's own arguments and nothing else", () => {
    expect(
      argvWithoutExtraArgs(["codex", "-m", "gpt", "-c", "x=1", "prompt"], ["-c", "x=1"]),
    ).toEqual(["codex", "-m", "gpt", "prompt"]);
    expect(argvWithoutExtraArgs(["codex", "-m", "gpt"], ["--absent"])).toEqual(["codex", "-m", "gpt"]);
  });
});

describe("parseHelpFlags", () => {
  it("reads commander-style help", () => {
    const flags = parseHelpFlags(
      [
        "Options:",
        "  -y, --yolo                    Start in Ask When Needed mode: routine edits run",
        "                                automatically. (default: false)",
        "  -m, --model <model>           LLM model alias to use for this invocation.",
        "  --add-dir <dir>               Add an additional workspace directory.",
        "",
        "Commands:",
        "  export [options] [sessionId]  Export a session as a ZIP archive.",
      ].join("\n"),
    );
    expect(flags.map((flag) => flag.flag)).toEqual(["--yolo", "--model", "--add-dir"]);
    expect(flags[0]).toMatchObject({ aliases: ["-y"] });
    expect(flags[0]?.description).toContain("automatically. (default: false)");
    expect(flags[1]).toMatchObject({ aliases: ["-m"], value: "<model>" });
  });

  it("reads clap long help, where the description sits on the next lines", () => {
    const flags = parseHelpFlags(
      [
        "Options:",
        "      --permission-mode <PERMISSION_MODE>",
        "          Permission mode",
        "",
        "          Modes: \"auto\" auto-approves read-only tools.",
        "",
        "  -c, --continue",
        "          Continue the most recent conversation",
      ].join("\n"),
    );
    expect(flags.map((flag) => flag.flag)).toEqual(["--permission-mode", "--continue"]);
    expect(flags[0]).toMatchObject({ value: "<PERMISSION_MODE>" });
    expect(flags[0]?.description).toContain("Permission mode");
    expect(flags[1]?.description).toBe("Continue the most recent conversation");
  });

  it("reads argparse and `--flag=<value>` spellings", () => {
    const flags = parseHelpFlags(
      [
        "options:",
        "  --reasoning LEVEL     Reasoning effort for this run",
        "      --approval-mode=<value>           Override tools.approvalMode",
        "  --yolo                Bypass approval prompts",
      ].join("\n"),
    );
    expect(flags).toEqual([
      { flag: "--reasoning", aliases: [], value: "LEVEL", description: "Reasoning effort for this run" },
      { flag: "--approval-mode", aliases: [], value: "<value>", description: "Override tools.approvalMode" },
      { flag: "--yolo", aliases: [], description: "Bypass approval prompts" },
    ]);
  });

  it("returns nothing for empty or option-free text", () => {
    expect(parseHelpFlags("")).toEqual([]);
    expect(parseHelpFlags("usage: thing <command>\n\nRun it.")).toEqual([]);
  });
});
