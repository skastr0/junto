/**
 * The add picker has one card. Every section the deck shows (profiles,
 * create profile, squads, the node catalog) renders its choices through the
 * shared PickerCard, so they share size, art slot, type, and menu. A section
 * that grows its own card fails here: in its markup, in its source, or in
 * its stylesheet.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/shared/agent-profiles";
import type { Squad } from "../src/shared/squads";
import { NodeCatalogGrid } from "../src/renderer/components/node-palette/NodeCatalogGrid";
import { ProfilePickerSection } from "../src/renderer/components/profiles/ProfilePickerSection";
import { SquadPickerSection } from "../src/renderer/components/squads/SquadPickerSection";
import { profiles$ } from "../src/renderer/lib/profiles-state";
import { squads$ } from "../src/renderer/lib/squads-state";

const DECK = "src/renderer/components/node-palette/NodePaletteModeDeck.tsx";

const profile: AgentProfile = {
  profileId: "p1",
  name: "Engineer",
  harness: "claude",
  soul: "Careful.",
  createdAt: 1,
  updatedAt: 1,
};

const squad: Squad = {
  squadId: "q1",
  name: "Engineering Team",
  createdAt: 1,
  updatedAt: 1,
  seats: ["a", "b", "c"].map((name, index) => ({
    key: `s${index}`,
    profile: { name, harness: "codex" },
    dx: index * 300,
    dy: 0,
    width: 240,
    height: 96,
  })),
  edges: [{ from: "s0", to: "s1", verb: "messages" }],
};

afterEach(() => {
  profiles$.list.set([]);
  squads$.list.set([]);
});

/** Every list item and every button a section renders, by class. */
const itemsOf = (html: string) => ({
  items: [...html.matchAll(/<li\b[^>]*>/g)].map((match) => match[0]),
  buttons: [...html.matchAll(/<button\b[^>]*class="([^"]*)"/g)].map((match) => match[1]!),
});

describe("picker card law", () => {
  it("renders every section's choices as the shared card", () => {
    profiles$.list.set([profile]);
    squads$.list.set([squad]);
    const sections = {
      profile: renderToStaticMarkup(<ProfilePickerSection query="" onPlace={() => undefined} onCreate={() => undefined} />),
      squad: renderToStaticMarkup(<SquadPickerSection query="" onPlace={() => undefined} />),
      catalog: renderToStaticMarkup(<NodeCatalogGrid onSelect={() => undefined} />),
    };
    const kinds = new Set<string>();
    for (const [name, html] of Object.entries(sections)) {
      const { items, buttons } = itemsOf(html);
      expect(items.length, name).toBeGreaterThan(0);
      for (const item of items) {
        expect(item, name).toMatch(/class="picker-card"/);
        kinds.add(/data-picker-card="([a-z]+)"/.exec(item)?.[1] ?? "none");
      }
      for (const button of buttons) {
        expect(button, name).toMatch(/\bpicker-card__(hit|more)\b/);
      }
      expect(html, name).toMatch(/class="picker-card-grid/);
    }
    expect([...kinds].sort()).toEqual(["catalog", "create", "profile", "squad"]);
  });

  it("gives squads and profiles the same menu", () => {
    profiles$.list.set([profile]);
    squads$.list.set([squad]);
    const profileHtml = renderToStaticMarkup(
      <ProfilePickerSection query="" onPlace={() => undefined} onCreate={() => undefined} />,
    );
    const squadHtml = renderToStaticMarkup(<SquadPickerSection query="" onPlace={() => undefined} />);
    expect(profileHtml).toContain('aria-label="Manage profile Engineer" title="Rename or delete"');
    expect(squadHtml).toContain('aria-label="Manage squad Engineering Team" title="Rename or delete"');
  });

  // Every section the deck imports: its source draws no list item or button
  // of its own, and its stylesheet declares no card chrome.
  const deckSource = readFileSync(DECK, "utf8");
  const sectionPaths = [...deckSource.matchAll(/from "(\.[^"]+(?:Section|Grid))"/g)].map(
    (match) => `${join(dirname(DECK), match[1]!)}.tsx`,
  );

  it("keeps card chrome out of the deck's own stylesheet", () => {
    const css = readFileSync(join(dirname(DECK), "node-palette-mode-deck.css"), "utf8");
    expect(css).not.toMatch(/(catalog|picker)__card\b/);
  });

  it("finds the deck's sections", () => {
    expect(sectionPaths.map((path) => path.split("/").pop())).toEqual(
      expect.arrayContaining(["NodeCatalogGrid.tsx", "SquadPickerSection.tsx", "ProfilePickerSection.tsx"]),
    );
  });

  it.each(sectionPaths)("%s draws no card of its own", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/<(li|button)\b/);
    expect(source).toMatch(/<PickerCard\b/);
    for (const sheet of source.matchAll(/import "(\.\/[^"]+\.css)"/g)) {
      const css = readFileSync(join(dirname(path), sheet[1]!), "utf8");
      expect(css, sheet[1]).not.toMatch(/(picker|catalog)__(card|item|list|more|slot)\b/);
    }
  });
});
