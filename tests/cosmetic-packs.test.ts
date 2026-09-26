import { Result, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { portraitCharacter, portraitGenome, portraitSvg } from "../src/shared/agent-portrait";
import { FREE_PACK, FREE_PACK_ID } from "../src/shared/cosmetics/free-pack";
import { cosmeticEntries, findCosmetic, installCosmeticPacks } from "../src/shared/cosmetics/catalog";
import { decodeCosmeticPacks, type CosmeticPackRejection } from "../src/shared/cosmetics/load";
import { CosmeticPack } from "../src/shared/cosmetics/pack-schema";
import { parseCosmeticPath } from "../src/shared/cosmetics/path";
import { normalizePortraitOverride } from "../src/shared/portrait-overrides";

const decode = Schema.decodeUnknownResult(CosmeticPack, { onExcessProperty: "error" });

// A neutral test pack (not premium art): one hat, one species, one palette.
const testPack = {
  format: 1,
  id: "test-pack",
  name: "Test pack",
  tier: "premium",
  accessories: [
    {
      id: "top-hat",
      name: "Top hat",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: { x: "center", y: "top" },
          shapes: [
            { kind: "path", d: "M -9 4 L -9 -18 L 9 -18 L 9 4 Z", paint: "inked", color: "ink" },
            { kind: "ellipse", cx: 0, cy: 4, rx: 16, ry: 3.5, paint: "inked", color: "ink" },
          ],
        },
      ],
    },
  ],
  species: [{ id: "blob", name: "Blob", body: { n: 2.6, w: 36, h: 30, cy: 66 } }],
  palettes: [{ id: "mint", name: "Mint", token: "green", lightness: 0.04, chroma: 0.8 }],
};

afterEach(() => {
  installCosmeticPacks([]);
});

describe("cosmetic pack schema", () => {
  it("admits the built-in free pack and the test pack", () => {
    expect(Result.isSuccess(decode(FREE_PACK))).toBe(true);
    expect(Result.isSuccess(decode(testPack))).toBe(true);
  });

  it("refuses anything that is not data in the closed format", () => {
    const withShape = (shape: Record<string, unknown>) => ({
      ...testPack,
      accessories: [{ ...testPack.accessories[0], parts: [{ ...testPack.accessories[0]!.parts[0], shapes: [shape] }] }],
    });
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["markup in a path", withShape({ kind: "path", d: 'M 0 0 L 1 1"/><script>alert(1)</script>', paint: "fill" })],
      ["relative path commands", withShape({ kind: "path", d: "m 0 0 l 4 4", paint: "fill" })],
      ["arcs", withShape({ kind: "path", d: "M 0 0 A 4 4 0 1 0 8 0", paint: "fill" })],
      ["a raw color", withShape({ kind: "circle", cx: 0, cy: 0, r: 4, paint: "fill", color: "#ff0000" })],
      ["an unknown attribute", withShape({ kind: "circle", cx: 0, cy: 0, r: 4, paint: "fill", onload: "x()" })],
      ["a coordinate outside the box", withShape({ kind: "circle", cx: 9999, cy: 0, r: 4, paint: "fill" })],
      ["markup in a name", { ...testPack, name: "<b>pack</b>" }],
      ["a crimson body", { ...testPack, palettes: [{ id: "red", name: "Red", token: "crimson" }] }],
      ["an unknown format", { ...testPack, format: 2 }],
      ["code in place of data", { ...testPack, accessories: [{ id: "x", name: "X", parts: () => [] }] }],
    ];
    for (const [label, pack] of cases) {
      expect(Result.isSuccess(decode(pack)), label).toBe(false);
    }
  });

  it("parses only the closed path grammar", () => {
    expect(parseCosmeticPath("M 0 0 H 4 V 4 Q 2 6 0 4 C 0 2 1 1 0 0 Z")).toHaveLength(6);
    expect(parseCosmeticPath("L 0 0")).toBeUndefined();
    expect(parseCosmeticPath("M 0 0 L 1")).toBeUndefined();
    expect(parseCosmeticPath("M 0 0 L 1 1e3")).toBeUndefined();
  });
});

describe("bundled pack loading", () => {
  it("keeps good packs and rejects bad ones with a clear reason each", () => {
    const rejections: CosmeticPackRejection[] = [];
    const packs = decodeCosmeticPacks(
      [
        testPack,
        { ...testPack, id: "broken", species: [{ id: "x", name: "X", body: { n: 2 } }] },
        { ...testPack },
        { ...testPack, id: FREE_PACK_ID },
        { ...testPack, id: "free-pack", tier: "free" },
        "not a pack",
      ],
      (rejection) => rejections.push(rejection),
    );
    expect(packs.map((pack) => pack.id)).toEqual(["test-pack"]);
    expect(rejections.map((rejection) => rejection.id ?? `#${rejection.index}`)).toEqual([
      "broken",
      "test-pack",
      FREE_PACK_ID,
      "free-pack",
      "#5",
    ]);
    expect(rejections.every((rejection) => rejection.reason.length > 0)).toBe(true);
  });
});

describe("bare keys and identity tables", () => {
  const barePack = {
    ...testPack,
    id: "bare-pack",
    keys: "bare",
    identity: { species: ["blob"], props: ["top-hat"], speciesMore: [], toppersMore: [], patternsMore: [] },
  };

  it("keeps plain keys for a bare pack, and its namespaced keys still resolve", () => {
    installCosmeticPacks(decodeCosmeticPacks([barePack]));
    expect(findCosmetic("species", "blob")?.packId).toBe("bare-pack");
    expect(findCosmetic("species", "bare-pack:blob")?.key).toBe("blob");
    expect(cosmeticEntries("accessory").filter((entry) => entry.key === "top-hat")).toHaveLength(1);
  });

  it("refuses a bare pack whose ids collide with installed ones", () => {
    const rejections: CosmeticPackRejection[] = [];
    const clash = { ...barePack, species: [{ id: "round", name: "Round two", body: { n: 2, w: 30, h: 30, cy: 60 } }] };
    expect(decodeCosmeticPacks([clash], (rejection) => rejections.push(rejection))).toEqual([]);
    expect(rejections[0]?.reason).toContain('"round"');
  });

  it("draws seats from the last declared identity table", () => {
    installCosmeticPacks(decodeCosmeticPacks([barePack]));
    const seats = Array.from({ length: 200 }, (_, index) => portraitGenome(`seat-${index}`));
    expect(new Set(seats.map((genome) => genome.shape))).toEqual(new Set(["blob"]));
    expect(seats.some((genome) => genome.accessory === "top-hat")).toBe(true);
    // Lists the pack does not declare keep the free pack's.
    expect(new Set(seats.map((genome) => genome.topper))).toEqual(new Set(FREE_PACK.identity?.toppers));
  });

  it("falls back to the free pack's table, with the same roll, for a drawn item this build lacks", () => {
    const base = Array.from({ length: 200 }, (_, index) => portraitGenome(`seat-${index}`).shape);
    installCosmeticPacks(decodeCosmeticPacks([{ ...barePack, identity: { species: ["missing-one", "missing-two"] } }]));
    expect(Array.from({ length: 200 }, (_, index) => portraitGenome(`seat-${index}`).shape)).toEqual(base);
  });

  it("skips parts below their minimum detail", () => {
    const freckled = {
      ...testPack,
      id: "detail-pack",
      patterns: [{ id: "dots", name: "Dots", parts: [{ layer: "body", anchor: { x: "face", y: "eye" }, minDetail: "card", shapes: [{ kind: "circle", cx: 14, cy: 8, r: 1, paint: "fill", color: "shade" }] }] }],
    };
    installCosmeticPacks(decodeCosmeticPacks([freckled]));
    const config = { marking: "detail-pack:dots" };
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "glyph", config })).toBe(portraitSvg({ seed: "a", mode: "dark", detail: "glyph", config: { marking: "none" } }));
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "card", config })).not.toBe(portraitSvg({ seed: "a", mode: "dark", detail: "card", config: { marking: "none" } }));
  });
});

describe("catalog and fallback", () => {
  it("resolves every identity draw to a free item", () => {
    for (let index = 0; index < 300; index += 1) {
      const genome = portraitGenome(`seat-${index}`);
      expect(findCosmetic("species", genome.shape)?.packId).toBe(FREE_PACK_ID);
      expect(findCosmetic("topper", genome.topper)?.packId).toBe(FREE_PACK_ID);
      expect(findCosmetic("pattern", genome.marking)?.packId).toBe(FREE_PACK_ID);
      expect(findCosmetic("accessory", genome.accessory)?.packId).toBe(FREE_PACK_ID);
      expect(findCosmetic("palette", genome.bodyHue)?.packId).toBe(FREE_PACK_ID);
    }
  });

  it("lists premium items after the free ones and draws them", () => {
    installCosmeticPacks(decodeCosmeticPacks([testPack]));
    const hats = cosmeticEntries("accessory");
    expect(hats[0]?.packId).toBe(FREE_PACK_ID);
    expect(hats.at(-1)).toMatchObject({ key: "test-pack:top-hat", tier: "premium", available: true });
    const config = { accessory: "test-pack:top-hat", shape: "test-pack:blob", bodyHue: "test-pack:mint" };
    expect(portraitCharacter("seat-a", config)).toMatchObject(config);
    expect(portraitSvg({ seed: "seat-a", mode: "dark", detail: "card", config })).not.toBe(
      portraitSvg({ seed: "seat-a", mode: "dark", detail: "card" }),
    );
  });

  it("wears the seat's free look when a premium item is not in this build", () => {
    installCosmeticPacks(decodeCosmeticPacks([testPack]));
    const config = { accessory: "test-pack:top-hat", shape: "test-pack:blob", bodyHue: "test-pack:mint" };
    installCosmeticPacks([]);
    for (const detail of ["glyph", "card", "rich"] as const) {
      expect(portraitSvg({ seed: "seat-a", mode: "bright", detail, config })).toBe(
        portraitSvg({ seed: "seat-a", mode: "bright", detail }),
      );
    }
    expect(normalizePortraitOverride(config)).toEqual(config);
  });
});
