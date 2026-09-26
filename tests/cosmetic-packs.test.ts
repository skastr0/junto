import { Result, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { portraitCharacter, portraitGenome, portraitSvg } from "../src/shared/agent-portrait";
import { BASE_PACK, BASE_PACK_ID } from "../src/shared/cosmetics/base-pack";
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
  it("admits the built-in base pack and the test pack", () => {
    expect(Result.isSuccess(decode(BASE_PACK))).toBe(true);
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
        { ...testPack, id: BASE_PACK_ID },
        { ...testPack, id: "free-pack", tier: "base" },
        "not a pack",
      ],
      (rejection) => rejections.push(rejection),
    );
    expect(packs.map((pack) => pack.id)).toEqual(["test-pack"]);
    expect(rejections.map((rejection) => rejection.id ?? `#${rejection.index}`)).toEqual([
      "broken",
      "test-pack",
      BASE_PACK_ID,
      "free-pack",
      "#5",
    ]);
    expect(rejections.every((rejection) => rejection.reason.length > 0)).toBe(true);
  });
});

describe("catalog and fallback", () => {
  it("resolves every identity draw to a base item", () => {
    for (let index = 0; index < 300; index += 1) {
      const genome = portraitGenome(`seat-${index}`);
      expect(findCosmetic("species", genome.shape)?.packId).toBe(BASE_PACK_ID);
      expect(findCosmetic("topper", genome.topper)?.packId).toBe(BASE_PACK_ID);
      expect(findCosmetic("pattern", genome.marking)?.packId).toBe(BASE_PACK_ID);
      expect(findCosmetic("accessory", genome.accessory)?.packId).toBe(BASE_PACK_ID);
      expect(findCosmetic("palette", genome.bodyHue)?.packId).toBe(BASE_PACK_ID);
    }
  });

  it("lists pack items after the base cast and draws them", () => {
    installCosmeticPacks(decodeCosmeticPacks([testPack]));
    const hats = cosmeticEntries("accessory");
    expect(hats[0]?.packId).toBe(BASE_PACK_ID);
    expect(hats.at(-1)).toMatchObject({ key: "test-pack:top-hat", tier: "premium", available: true });
    const config = { accessory: "test-pack:top-hat", shape: "test-pack:blob", bodyHue: "test-pack:mint" };
    expect(portraitCharacter("seat-a", config)).toMatchObject(config);
    expect(portraitSvg({ seed: "seat-a", mode: "dark", detail: "card", config })).not.toBe(
      portraitSvg({ seed: "seat-a", mode: "dark", detail: "card" }),
    );
  });

  it("wears the seat's base look when a pack item is not in this build", () => {
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
