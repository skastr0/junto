/**
 * Profiles in the add picker: a card per profile (name, harness, model, a
 * line of soul) plus the Create profile card, filtered by the picker's search.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/shared/agent-profiles";
import { ProfilePickerSection } from "../src/renderer/components/profiles/ProfilePickerSection";
import { profiles$ } from "../src/renderer/lib/profiles-state";
import { discardProfileDraft, openProfileDraft, updateProfileDraft } from "../src/renderer/lib/profile-draft-state";

const profile = (profileId: string, name: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  profileId,
  name,
  harness: "claude",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

afterEach(() => {
  profiles$.list.set([]);
  discardProfileDraft();
});

const render = (query = "") =>
  renderToStaticMarkup(<ProfilePickerSection query={query} onPlace={() => undefined} onCreate={() => undefined} />);

describe("ProfilePickerSection", () => {
  it("offers Create profile when there are none yet", () => {
    const html = render();
    expect(html).toContain('aria-label="Profiles"');
    expect(html).toContain("Create profile");
    expect(html).not.toContain("Place profile");
  });

  it("offers to continue a draft that was closed unsaved", () => {
    openProfileDraft();
    updateProfileDraft((draft) => ({ ...draft, name: "Scout" }));
    const html = render();
    expect(html).toContain("Continue profile");
    expect(html).toContain("Scout, not saved yet.");
  });

  it("shows a card per profile: name, harness, model, a line of soul", () => {
    profiles$.list.set([
      profile("p1", "Reviewer", { model: "opus", effort: "high", soul: "# Who\nA careful reviewer.\nSpeaks plainly." }),
      profile("p2", "Builder", { harness: "codex" }),
    ]);
    const html = render();
    expect(html).toContain("Place profile Reviewer, Claude Code, opus, high");
    expect(html).toContain(">Claude Code<");
    expect(html).toContain(">opus, high<");
    expect(html).toContain(">Who<");
    expect(html).toContain(">harness default model<");
    expect(html).toContain(">No soul yet<");
    expect(html).toContain("Manage profile Builder");
    expect(html).not.toContain("Update from seat");
    expect(html).not.toContain("·");
  });

  it("filters by name, harness line, or soul and hides when nothing matches", () => {
    profiles$.list.set([
      profile("p1", "Reviewer", { model: "opus", soul: "Careful." }),
      profile("p2", "Builder", { harness: "codex" }),
    ]);
    expect(render("rev")).toContain("Reviewer");
    expect(render("rev")).not.toContain("Builder");
    expect(render("opus")).toContain("Reviewer");
    expect(render("careful")).toContain("Reviewer");
    expect(render("rev")).not.toContain("Create profile");
    expect(render("create")).toContain("Create profile");
    expect(render("zzz")).toBe("");
  });
});
