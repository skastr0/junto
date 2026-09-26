/**
 * Profiles in the add picker: hidden with no profiles, one tile per profile
 * with its harness line, filtered by the picker's search.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/shared/agent-profiles";
import { ProfilePickerSection } from "../src/renderer/components/profiles/ProfilePickerSection";
import { profiles$ } from "../src/renderer/lib/profiles-state";

const profile = (profileId: string, name: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  profileId,
  name,
  harness: "claude",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

afterEach(() => profiles$.list.set([]));

const render = (query = "") =>
  renderToStaticMarkup(<ProfilePickerSection query={query} onPlace={() => undefined} />);

describe("ProfilePickerSection", () => {
  it("renders nothing without profiles", () => {
    expect(render()).toBe("");
  });

  it("shows one tile per profile with its harness line, and a manage button", () => {
    profiles$.list.set([
      profile("p1", "Reviewer", { model: "opus", effort: "high" }),
      profile("p2", "Builder", { harness: "codex" }),
    ]);
    const html = render();
    expect(html).toContain('aria-label="Profiles"');
    expect(html).toContain("Place profile Reviewer, Claude Code, opus, high");
    expect(html).toContain("Manage profile Builder");
    expect(html).not.toContain("·");
  });

  it("filters by name or harness line and hides when nothing matches", () => {
    profiles$.list.set([profile("p1", "Reviewer", { model: "opus" }), profile("p2", "Builder", { harness: "codex" })]);
    expect(render("rev")).toContain("Reviewer");
    expect(render("rev")).not.toContain("Builder");
    expect(render("opus")).toContain("Reviewer");
    expect(render("zzz")).toBe("");
  });
});
