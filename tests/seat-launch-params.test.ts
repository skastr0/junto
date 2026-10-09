import { describe, expect, it } from "vitest";
import type { Seat } from "../src/shared/model";
import { seat as modelSeat } from "./support/model-nodes";
import { recoverDocumentLaunchChoices } from "../src/shared/launch-choices";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";
import {
  permissionModeOptions,
  planSeatLaunch,
  seatRelaunch,
  seatLaunchParamsChangeError,
  seatLaunchParamsDiffer,
  seatLaunchParamsOf,
} from "../src/shared/seat-launch-params";
import { applySettingsPatch, defaultSettings, harnessPrefsFor } from "../src/shared/settings";
import { planManagedSpawn } from "../src/main/junto/term/managed-spawn-plan";

const seat = (
  harness: "claude" | "codex" | "hermes" | "devin" | "amp",
  params: Parameters<typeof planSeatLaunch>[0]["params"] = {},
): Seat =>
  modelSeat("agent-1", {
    label: "Seat" as never,
    agentKey: `local:${harness}` as never,
    bindingId: "binding-1" as never,
    harness,
    launch: planSeatLaunch({
      harness,
      params,
      base: { cwd: "/work" },
    }).launch as Seat["launch"],
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

  it("relaunch is a new launch alone, without a session id and in the same folder", () => {
    const node = seat("claude", { model: "opus" });
    const next = seatRelaunch(node, {
      model: "sonnet",
      permissionMode: "bypassPermissions",
      extraArgs: ["--verbose"],
    });
    expect(next?.rejected).toEqual([]);
    // The result names a launch and nothing else: the binding and the session are the seat's.
    expect(Object.keys(next ?? {}).sort()).toEqual(["launch", "rejected"]);
    expect(next?.launch.cwd).toBe("/work");
    expect(next?.launch.extraArgs).toEqual(["--verbose"]);
    const argv = next?.launch.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["--model", "sonnet", "--permission-mode", "bypassPermissions", "--verbose"]));
    expect(argv).not.toContain("--session-id");
  });

  it("clearing a parameter returns it to the template default", () => {
    const node = seat("claude", { model: "opus", extraArgs: ["--verbose"] });
    const next = seatRelaunch(node, {});
    const argv = next?.launch.argv ?? [];
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--verbose");
    expect(next?.launch.extraArgs).toBeUndefined();
  });

  it("reports refused extra arguments instead of launching with them", () => {
    const next = seatRelaunch(seat("claude"), {
      extraArgs: ["--session-id", "other", "--verbose"],
    });
    expect(next?.launch.extraArgs).toEqual(["--verbose"]);
    expect(next?.rejected.map((item) => item.token)).toEqual(["--session-id"]);
  });

  it("keeps the Hermes profile and provider that the editor does not show", () => {
    const base = seat("hermes");
    const withProfile: Seat = {
      ...base,
      launch: {
        kind: "harness",
        argv: ["hermes", "chat", "--tui", "--profile", "coder", "--provider", "nous", "-m", "m1"],
      },
    };
    const argv = seatRelaunch(withProfile, { model: "m2" })?.launch.argv ?? [];
    expect(argv).toEqual(expect.arrayContaining(["--profile", "coder", "--provider", "nous", "-m", "m2"]));
  });

  it("an operator `-c` on Codex does not shadow the effort it also rides on", () => {
    const node = seat("codex", { effort: "high", extraArgs: ["-c", "foo=1"] });
    expect(recoverDocumentLaunchChoices("codex", node.launch)).toMatchObject({
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

describe("Amp parameters respect the existing thread", () => {
  const threadId = "T-00000000-0000-4000-8000-000000000001";

  it("allows mode and features before provisioning, but refuses to rewrite a named thread", () => {
    const newSeat = seat("amp", { mode: "low" });
    expect(seatLaunchParamsChangeError(newSeat, { mode: "fixture-reviewer", extraArgs: ["--fast"] }, false)).toBeUndefined();
    expect(seatRelaunch(newSeat, { mode: "fixture-reviewer" })?.launch.argv).toContain("fixture-reviewer");

    const existing = seat("amp", { mode: "low" });
    expect(seatLaunchParamsChangeError(existing, { mode: "high" }, true)).toContain("mode");
    expect(seatRelaunch(existing, { mode: "high" }, true)).toBeUndefined();
    expect(seatLaunchParamsChangeError(existing, {}, true)).toContain("mode");
    expect(seatLaunchParamsChangeError(existing, { mode: "LOW" }, true)).toBeUndefined();
  });

  it("keeps startup features while allowing client flags, without promising CLI feature mutation", () => {
    const existing = seat("amp", { mode: "low", extraArgs: ["--features", "plaid", "--no-color"] });
    expect(seatLaunchParamsChangeError(existing, { mode: "low", extraArgs: ["--features", "plaid", "--no-notifications"] }, true)).toBeUndefined();
    expect(seatLaunchParamsChangeError(existing, { mode: "low", extraArgs: ["--fast"] }, true)).toContain("features");
    expect(seatRelaunch(existing, { mode: "low", extraArgs: [] }, true)).toBeUndefined();

    const relaunched = seatRelaunch(existing, { mode: "low", extraArgs: ["--features", "plaid", "--no-notifications"] }, true);
    expect(relaunched?.launch.extraArgs).toEqual(["--features", "plaid", "--no-notifications"]);
  });

  it("resumes the exact Amp thread without reapplying its creation mode or features", () => {
    const node = seat("amp", { mode: "fixture-reviewer", extraArgs: ["--features=pro", "--fast", "--no-notifications"] });
    expect(planManagedSpawn({
      harness: "amp",
      sessionId: threadId,
      documentLaunch: node.launch,
      resume: true,
    })?.launch.argv).toEqual([
      "amp", "--no-ide", "threads", "continue", threadId, "--no-notifications",
    ]);
    // Authorial choices stay available to profiles and re-seating.
    expect(seatLaunchParamsOf(node)?.params).toEqual({
      mode: "fixture-reviewer",
      extraArgs: ["--features=pro", "--fast", "--no-notifications"],
    });
  });

  it("recovers Amp's long mode alias, with last occurrence winning across aliases", () => {
    expect(recoverDocumentLaunchChoices("amp", {
      kind: "harness", argv: ["amp", "-m", "low", "--mode=fixture-reviewer"],
    })).toEqual({ mode: "fixture-reviewer" });
    expect(recoverDocumentLaunchChoices("amp", {
      kind: "harness", argv: ["amp", "--mode", "fixture-reviewer", "-m", "medium"],
    })).toEqual({ mode: "medium" });
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
    const node = seat("claude", { extraArgs: ["--add-dir", "/tmp/x"] });
    const plan = planManagedSpawn({
      harness: "claude",
      documentLaunch: node.launch,
      sessionId: "22222222-2222-4222-8222-222222222222",
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
    const { profileBodyOfSeat, seatFromProfile } = await import("../src/renderer/lib/agent-profiles");
    const node = seat("claude", {
      model: "opus",
      permissionMode: "bypassPermissions",
      extraArgs: ["--add-dir", "/tmp/x", "--verbose"],
    });
    const body = profileBodyOfSeat(node);
    expect(body).toMatchObject({
      harness: "claude",
      model: "opus",
      permissionMode: "bypassPermissions",
      extraArgs: ["--add-dir", "/tmp/x", "--verbose"],
    });
    const placed = seatFromProfile(body!, { x: 0, y: 0, host: "workbench", cwd: "/work" });
    if (!placed.ok) throw new Error(placed.message);
    const launch = placed.node.launch;
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
