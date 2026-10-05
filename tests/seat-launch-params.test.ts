import { describe, expect, it } from "vitest";
import type { TextNode } from "../src/shared/canvas";
import { recoverDocumentLaunchChoices } from "../src/shared/launch-choices";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";
import {
  permissionModeOptions,
  planSeatLaunch,
  relaunchManagedAgentNode,
  seatLaunchParamsDiffer,
  seatLaunchParamsOf,
} from "../src/shared/seat-launch-params";
import { applySettingsPatch, defaultSettings, harnessPrefsFor } from "../src/shared/settings";
import { planManagedSpawn } from "../src/main/junto/term/managed-spawn-plan";

const seat = (
  harness: "claude" | "codex" | "hermes" | "devin",
  params: Parameters<typeof planSeatLaunch>[0]["params"] = {},
  sessionId?: string,
): TextNode => ({
  id: "agent-1",
  type: "text",
  text: "Seat",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${harness}` },
    host: "local",
    terminal: {
      bindingId: "binding-1",
      harness,
      ...(sessionId ? { sessionId } : {}),
      launch: planSeatLaunch({
        harness,
        params,
        base: { cwd: "/work", ...(sessionId ? { sessionId } : {}) },
      }).launch,
    },
  },
});

describe("seat start parameters", () => {
  it("reads the stored parameters back from the seat's launch", () => {
    const node = seat("claude", {
      model: "opus",
      permissionMode: "plan",
      extraArgs: ["--add-dir", "/tmp/x"],
    });
    expect(seatLaunchParamsOf(node)?.params).toEqual({
      model: "opus",
      permissionMode: "plan",
      extraArgs: ["--add-dir", "/tmp/x"],
    });
  });

  it("relaunch keeps the binding, the session and the folder; only the launch changes", () => {
    const session = "11111111-1111-4111-8111-111111111111";
    const node = seat("claude", { model: "opus" }, session);
    const next = relaunchManagedAgentNode(node, {
      model: "sonnet",
      permissionMode: "bypassPermissions",
      extraArgs: ["--verbose"],
    });
    expect(next?.rejected).toEqual([]);
    const terminal = next?.node.ether?.terminal;
    expect(terminal?.bindingId).toBe("binding-1");
    expect(terminal?.sessionId).toBe(session);
    expect(terminal?.launch?.cwd).toBe("/work");
    expect(terminal?.launch?.extraArgs).toEqual(["--verbose"]);
    const argv = terminal?.launch?.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["--model", "sonnet", "--permission-mode", "bypassPermissions", "--verbose"]));
    expect(argv).toContain(session);
    expect(next?.node.id).toBe(node.id);
    expect(next?.node.text).toBe(node.text);
  });

  it("clearing a parameter returns it to the template default", () => {
    const node = seat("claude", { model: "opus", extraArgs: ["--verbose"] });
    const next = relaunchManagedAgentNode(node, {});
    const argv = next?.node.ether?.terminal?.launch?.argv ?? [];
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--verbose");
    expect(next?.node.ether?.terminal?.launch?.extraArgs).toBeUndefined();
  });

  it("reports refused extra arguments instead of launching with them", () => {
    const next = relaunchManagedAgentNode(seat("claude"), {
      extraArgs: ["--session-id", "other", "--verbose"],
    });
    expect(next?.node.ether?.terminal?.launch?.extraArgs).toEqual(["--verbose"]);
    expect(next?.rejected.map((item) => item.token)).toEqual(["--session-id"]);
  });

  it("keeps the Hermes profile and provider that the editor does not show", () => {
    const base = seat("hermes");
    const withProfile: TextNode = {
      ...base,
      ether: {
        ...base.ether!,
        terminal: {
          ...base.ether!.terminal!,
          launch: {
            kind: "harness",
            argv: ["hermes", "chat", "--tui", "--profile", "coder", "--provider", "nous", "-m", "m1"],
          },
        },
      },
    };
    const argv = relaunchManagedAgentNode(withProfile, { model: "m2" })?.node.ether?.terminal?.launch?.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["--profile", "coder", "--provider", "nous", "-m", "m2"]));
  });

  it("is undefined for a node that is not a managed seat", () => {
    const note = { id: "n", type: "text", text: "", x: 0, y: 0, width: 1, height: 1 } as TextNode;
    expect(relaunchManagedAgentNode(note, {})).toBeUndefined();
    expect(seatLaunchParamsOf(note)).toBeUndefined();
  });

  it("an operator `-c` on Codex does not shadow the effort it also rides on", () => {
    const node = seat("codex", { effort: "high", extraArgs: ["-c", "foo=1"] });
    expect(recoverDocumentLaunchChoices("codex", node.ether?.terminal?.launch)).toMatchObject({
      effort: "high",
      extraArgs: ["-c", "foo=1"],
    });
  });

  it("detects a change in any parameter", () => {
    expect(seatLaunchParamsDiffer({ model: "a" }, { model: "a", extraArgs: [] })).toBe(false);
    expect(seatLaunchParamsDiffer({ model: "a" }, { model: "b" })).toBe(true);
    expect(seatLaunchParamsDiffer({ extraArgs: ["--x"] }, { extraArgs: ["--x", "--y"] })).toBe(true);
  });

  it("offers permission modes only where the harness has a dial", () => {
    expect(permissionModeOptions("claude")).toContain("bypassPermissions");
    expect(permissionModeOptions("claude", "custom")).toContain("custom");
    expect(permissionModeOptions("pi")).toEqual([]);
  });
});

describe("extra arguments ride every launch of the seat", () => {
  it("sit after the template flags and before a positional prompt", () => {
    const plan = resolveManagedLaunchPlan("claude", {
      model: "opus",
      extraArgs: ["--verbose"],
      prompt: "hello",
    });
    const argv = plan.launch.argv ?? [];
    expect(argv.indexOf("--verbose")).toBeGreaterThan(argv.indexOf("opus"));
    expect(argv[argv.length - 1]).toBe("hello");
  });

  it("are re-passed when the spawn planner replans the seat", () => {
    const node = seat("claude", { extraArgs: ["--add-dir", "/tmp/x"] }, "22222222-2222-4222-8222-222222222222");
    const plan = planManagedSpawn({
      harness: "claude",
      documentLaunch: node.ether?.terminal?.launch,
      sessionId: node.ether?.terminal?.sessionId,
      resume: false,
    });
    expect(plan?.launch.argv).toEqual(expect.arrayContaining(["--add-dir", "/tmp/x"]));
  });
});

describe("harness settings: default extra arguments", () => {
  it("stores, trims and clears the list", () => {
    const set = applySettingsPatch(defaultSettings(), {
      harnesses: { byHarness: { claude: { extraArgs: [" --verbose ", ""] } } },
    });
    expect(harnessPrefsFor(set, "claude").extraArgs).toEqual(["--verbose"]);
    const cleared = applySettingsPatch(set, {
      harnesses: { byHarness: { claude: { extraArgs: [] } } },
    });
    expect(harnessPrefsFor(cleared, "claude").extraArgs).toBeUndefined();
  });
});

describe("profiles and squads carry the start parameters", () => {
  it("captures a seat's parameters into a profile and seats them again", async () => {
    const { profileBodyFromSeat, seatFromProfile } = await import("../src/renderer/lib/agent-profiles");
    const node = seat("claude", {
      model: "opus",
      permissionMode: "bypassPermissions",
      extraArgs: ["--add-dir", "/tmp/x", "--verbose"],
    });
    const body = profileBodyFromSeat(node);
    expect(body).toMatchObject({
      harness: "claude",
      model: "opus",
      permissionMode: "bypassPermissions",
      extraArgs: ["--add-dir", "/tmp/x", "--verbose"],
    });
    const placed = seatFromProfile(body!, { x: 0, y: 0, host: "local", cwd: "/work" });
    if (!placed.ok) throw new Error(placed.message);
    const launch = placed.node.ether?.terminal?.launch;
    expect(launch?.extraArgs).toEqual(["--add-dir", "/tmp/x", "--verbose"]);
    expect(launch?.argv).toEqual(
      expect.arrayContaining(["--model", "opus", "--permission-mode", "bypassPermissions", "--add-dir", "/tmp/x", "--verbose"]),
    );
  });

  it("decodes stored extra arguments leniently and keeps them on squad members", async () => {
    const { decodeProfileBody } = await import("../src/shared/agent-profiles");
    const { decodeSquadBody } = await import("../src/shared/squads");
    const { Result } = await import("effect");
    expect(
      decodeProfileBody({ name: "a", harness: "claude", extraArgs: ["--verbose", 7, "  ", " --x "] })?.extraArgs,
    ).toEqual(["--verbose", "--x"]);
    expect(decodeProfileBody({ name: "a", harness: "claude", extraArgs: "nope" })?.extraArgs).toBeUndefined();

    const squad = decodeSquadBody({
      seats: [
        {
          key: "s1",
          dx: 0,
          dy: 0,
          width: 240,
          height: 96,
          profile: { name: "a", harness: "codex", extraArgs: ["-c", "k=v"] },
        },
      ],
      edges: [],
    });
    if (Result.isFailure(squad)) throw new Error(squad.failure);
    expect(squad.success.seats[0]?.profile.extraArgs).toEqual(["-c", "k=v"]);
  });
});
