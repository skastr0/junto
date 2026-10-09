import { describe, expect, it } from "vitest";
import { asNodeId, type NodeOf } from "../src/shared/model";
import {
  PROFILE_NAME_MAX,
  decodeProfileBody,
  profileNamed,
  profileSummary,
  type AgentProfile,
} from "../src/shared/agent-profiles";
import { SEAT_SOUL_MAX } from "../src/shared/seat-guidance";
import { portraitCharacter } from "../src/shared/agent-portrait";
import { newSeat } from "../src/renderer/lib/model-factories";
import { note, terminal } from "./support/model-nodes";
import {
  profileBodyOfSeat,
  resolvedPortrait,
  seatFromProfile,
} from "../src/renderer/lib/agent-profiles";
import { THIS_MACHINE } from "./support/machines";

const claude = (id: string): NodeOf<"agent"> => ({
  ...newSeat({ x: 0, y: 0, z: 0 }, { harness: "claude", host: THIS_MACHINE, cwd: "~/work", label: "Ada", model: "opus", effort: "high" }),
  id: asNodeId(id),
});

describe("decodeProfileBody", () => {
  it("needs a name and a harness", () => {
    expect(decodeProfileBody({ harness: "claude" })).toBeNull();
    expect(decodeProfileBody({ name: "Ada" })).toBeNull();
    expect(decodeProfileBody({ name: "x".repeat(PROFILE_NAME_MAX + 1), harness: "claude" })).toBeNull();
    expect(decodeProfileBody([])).toBeNull();
  });

  it("keeps well-shaped fields, drops malformed or over-bound ones on their own", () => {
    const body = decodeProfileBody({
      name: "  Ada   Lovelace ",
      harness: "claude",
      model: "opus",
      effort: 3,
      portrait: { eyes: "dot", unknown: "x" },
      soul: "s".repeat(SEAT_SOUL_MAX + 1),
      instructions: " Test first. ",
      cwd: "~/not-part-of-a-profile",
    });
    expect(body).toEqual({
      name: "Ada Lovelace",
      harness: "claude",
      model: "opus",
      portrait: { eyes: "dot" },
      instructions: "Test first.",
    });
  });

  it("admits a harness this build does not know, for placement to judge", () => {
    expect(decodeProfileBody({ name: "Later", harness: "harness-from-later" })?.harness).toBe("harness-from-later");
  });
});

describe("profileNamed and profileSummary", () => {
  const profile = { profileId: "p1", createdAt: 1, updatedAt: 1, name: "Reviewer", harness: "claude" } as AgentProfile;
  it("finds a profile by name, ignoring case", () => {
    expect(profileNamed([profile], " reviewer ")?.profileId).toBe("p1");
    expect(profileNamed([profile], "builder")).toBeUndefined();
  });
  it("reads harness then dials, with no middle dots", () => {
    expect(profileSummary({ name: "x", harness: "claude", model: "opus", effort: "high" }, "Claude")).toBe("Claude, opus, high");
  });
});

describe("profileBodyOfSeat", () => {
  it("captures name, harness dials from argv, the resolved face, soul, and instructions", () => {
    const seat = claude("seat-1");
    const body = profileBodyOfSeat(seat, {
      portraitOf: () => ({ topper: "cat" }),
      guidanceOf: () => ({ soul: "Careful.", instructions: "Test first." }),
    })!;
    const character = portraitCharacter("seat-1", { topper: "cat" });
    expect(body).toMatchObject({ name: "Ada", harness: "claude", model: "opus", effort: "high", soul: "Careful.", instructions: "Test first." });
    expect(body.portrait).toMatchObject({ topper: character.topper, bodyHue: character.bodyHue, shape: character.shape });
    expect(body).not.toHaveProperty("cwd");
  });

  it("captures nothing from a note or a raw terminal", () => {
    expect(profileBodyOfSeat(note("n"))).toBeNull();
    expect(profileBodyOfSeat(terminal("t"))).toBeNull();
    expect(profileBodyOfSeat(undefined)).toBeNull();
  });
});

describe("seatFromProfile", () => {
  const body = profileBodyOfSeat(claude("seat-1"), { guidanceOf: () => ({ soul: "Careful." }) })!;

  it("mints a fresh seat with the same harness and dials, here, with its soul to save", () => {
    const placed = seatFromProfile(body, { x: 40, y: 80, host: THIS_MACHINE, cwd: "~/other-project" });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const terminal = placed.node;
    expect(placed.node.id).not.toBe("seat-1");
    expect([placed.node.x, placed.node.y]).toEqual([40, 80]);
    expect(terminal).toMatchObject({ harness: "claude", label: "Ada" });
    expect(terminal.launch?.argv).toEqual(expect.arrayContaining(["--model", "opus"]));
    expect(terminal.launch?.cwd).toBe("~/other-project");
    expect(placed.guidance).toEqual({ soul: "Careful." });
    expect(placed.portrait).toEqual(body.portrait);
  });

  it("two placements are two seats: new ids, bindings, and sessions", () => {
    const a = seatFromProfile(body, { x: 0, y: 0, host: THIS_MACHINE, cwd: "~/w" });
    const b = seatFromProfile(body, { x: 0, y: 0, host: THIS_MACHINE, cwd: "~/w" });
    if (!a.ok || !b.ok) throw new Error("placement failed");
    expect(a.node.id).not.toBe(b.node.id);
    expect(a.node.bindingId).not.toBe(b.node.bindingId);
  });

  it("refuses a harness this build cannot run instead of placing something adjacent", () => {
    const placed = seatFromProfile({ ...body, harness: "harness-from-later" }, { x: 0, y: 0, host: THIS_MACHINE, cwd: "~/w" });
    expect(placed).toMatchObject({ ok: false });
  });

  it("the resolved face draws the same on any node id", () => {
    const face = resolvedPortrait("seat-1", { eyes: "dot" })!;
    const onNew = portraitCharacter("seat-2", face);
    const onOld = portraitCharacter("seat-1", { eyes: "dot" });
    expect({ shape: onNew.shape, bodyHue: onNew.bodyHue, eyes: onNew.eyes }).toEqual({
      shape: onOld.shape,
      bodyHue: onOld.bodyHue,
      eyes: onOld.eyes,
    });
  });
});
