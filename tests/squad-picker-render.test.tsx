/**
 * Squads in the add picker: hidden with no squads, one card per squad with
 * its size, filtered by the picker's search.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Squad } from "../src/shared/squads";
import { SquadPickerSection } from "../src/renderer/components/squads/SquadPickerSection";
import { squads$ } from "../src/renderer/lib/squads-state";

const squad = (squadId: string, name: string, seats: number): Squad => ({
  squadId,
  name,
  createdAt: 1,
  updatedAt: 1,
  seats: Array.from({ length: seats }, (_, index) => ({
    key: `s${index}`,
    harness: "codex",
    label: `seat ${index}`,
    entityName: "local:codex",
    host: "local",
    launch: { argv: ["codex"] },
    dx: index * 300,
    dy: 0,
    width: 240,
    height: 96,
  })),
  edges: seats > 1 ? [{ from: "s0", to: "s1", verb: "messages" }] : [],
});

afterEach(() => squads$.list.set([]));

const render = (query = "") =>
  renderToStaticMarkup(<SquadPickerSection query={query} onPlace={() => undefined} />);

describe("SquadPickerSection", () => {
  it("renders nothing without squads", () => {
    expect(render()).toBe("");
  });

  it("shows one card per squad with its size", () => {
    squads$.list.set([squad("q1", "Review squad", 3), squad("q2", "Solo", 1)]);
    const html = render();
    expect(html).toContain('aria-label="Squads"');
    expect(html).toContain("Place squad Review squad, 3 agents, 1 connection");
    expect(html).toContain("Place squad Solo, 1 agent");
    expect(html).toContain("Manage squad Review squad");
    expect(html).not.toContain("·");
  });

  it("filters by the search and hides when nothing matches", () => {
    squads$.list.set([squad("q1", "Review squad", 3), squad("q2", "Solo", 1)]);
    expect(render("rev")).toContain("Review squad");
    expect(render("rev")).not.toContain("Solo");
    expect(render("zzz")).toBe("");
  });
});
