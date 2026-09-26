/**
 * Create profile: a draft built in the customize editor becomes a profile
 * body (face resolved, launch, soul, instructions) without any seat; a closed
 * draft waits for the next open; saving ends it and adds the profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, ProfileSaveInput } from "../src/shared/agent-profiles";
import {
  DRAFT_NAME,
  closeProfileDraft,
  discardProfileDraft,
  openProfileDraft,
  profileDraft$,
  profileDraftBody,
  profileDraftOpen$,
  saveProfileDraft,
  updateProfileDraft,
} from "../src/renderer/lib/profile-draft-state";
import { profiles$ } from "../src/renderer/lib/profiles-state";
import { state$ } from "../src/renderer/lib/state";
import { portraitOptions } from "../src/shared/agent-portrait";

const saved: ProfileSaveInput[] = [];

beforeEach(() => {
  saved.length = 0;
  vi.stubGlobal("window", {
    junto: {
      profileSave: async (input: ProfileSaveInput) => {
        saved.push(input);
        const profile: AgentProfile = { ...input.body, profileId: input.profileId ?? "p-new", createdAt: 1, updatedAt: 1 };
        return { ok: true, profile };
      },
    },
  });
});

afterEach(() => {
  discardProfileDraft();
  profiles$.list.set([]);
  vi.unstubAllGlobals();
});

describe("profile draft", () => {
  it("opens on a named draft and keeps it through a close", () => {
    openProfileDraft();
    const draft = profileDraft$.peek()!;
    expect(draft.name).toBe(DRAFT_NAME);
    expect(profileDraftOpen$.peek()).toBe(true);
    updateProfileDraft((current) => ({ ...current, name: "Scout" }));
    closeProfileDraft();
    expect(profileDraftOpen$.peek()).toBe(false);
    openProfileDraft();
    expect(profileDraft$.peek()).toMatchObject({ id: draft.id, name: "Scout" });
  });

  it("is a profile body with the face resolved, the launch, and the guidance", () => {
    const hue = portraitOptions().bodyHue.at(-1)!;
    openProfileDraft();
    updateProfileDraft((draft) => ({
      ...draft,
      name: "Scout",
      launch: { harness: "codex", model: "gpt-5.5", effort: "high" },
      portrait: { bodyHue: hue },
      guidance: { soul: "Curious.", instructions: "Report back." },
    }));
    const body = profileDraftBody(profileDraft$.peek()!)!;
    expect(body).toMatchObject({
      name: "Scout",
      harness: "codex",
      model: "gpt-5.5",
      effort: "high",
      soul: "Curious.",
      instructions: "Report back.",
    });
    // Every trait resolved, so a seat's new id draws this same face.
    expect(body.portrait?.bodyHue).toBe(hue);
    expect(Object.keys(body.portrait ?? {}).length).toBeGreaterThan(5);
  });

  it("refuses an empty name and saves nothing", async () => {
    openProfileDraft();
    updateProfileDraft((draft) => ({ ...draft, name: "  " }));
    expect(await saveProfileDraft()).toBe("give the profile a name");
    expect(saved).toEqual([]);
    expect(profileDraft$.peek()).not.toBeNull();
  });

  it("saves a new profile or replaces one, ends the draft, and makes no seat", async () => {
    const nodes = state$.doc.nodes.peek().length;
    openProfileDraft();
    updateProfileDraft((draft) => ({ ...draft, name: "Scout" }));
    expect(await saveProfileDraft("p-old")).toBe("");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ profileId: "p-old", body: { name: "Scout", harness: "claude" } });
    expect(profiles$.list.peek().map((profile) => profile.name)).toEqual(["Scout"]);
    expect(profileDraft$.peek()).toBeNull();
    expect(profileDraftOpen$.peek()).toBe(false);
    expect(state$.doc.nodes.peek().length).toBe(nodes);
  });
});
