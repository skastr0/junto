import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  GLYPHS,
  MONOGRAM_HUES,
  Marks,
  MarksLive,
  harnessDisplayName,
  harnessGlyphFor,
  harnessHue,
  markTileFor,
  marks,
  type HarnessGlyph,
  type MarksService,
} from "../src/renderer/lib/harness-icons";
import { PROVIDER_MARKS } from "../src/renderer/lib/provider-marks.generated";
import { DIM, HUE, INK } from "../src/renderer/lib/theme";

describe("PROVIDER_MARKS (generated table integrity)", () => {
  it("carries the provider-published monochrome vector set", () => {
    for (const id of [
      "amp",
      "bedrock",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "devin",
      "grok",
      "openai",
      "opencode",
      "opencodego",
      "openrouter",
      "wayfinder",
      "windsurf",
      "zed",
    ]) {
      expect(PROVIDER_MARKS[id], id).toBeDefined();
    }
  });

  it("every entry has at least one non-empty path and a 4-number viewBox", () => {
    for (const [id, mark] of Object.entries(PROVIDER_MARKS)) {
      expect(mark.paths.length, id).toBeGreaterThan(0);
      for (const d of mark.paths) {
        expect(typeof d, id).toBe("string");
        expect(d.trim().length, id).toBeGreaterThan(0);
      }
      const parts = mark.viewBox.trim().split(/\s+/).map(Number);
      expect(parts, id).toHaveLength(4);
      expect(parts.every((n) => Number.isFinite(n)), id).toBe(true);
    }
  });
});

describe("repository coverage", () => {
  it("resolves every generated provider id via canonical pass-through", () => {
    for (const id of Object.keys(PROVIDER_MARKS)) {
      expect(harnessGlyphFor(id), id).toBeDefined();
    }
  });

  it("maps generated entries through with their own viewBox, paths, and fillRule", () => {
    for (const id of ["grok", "codex", "devin", "amp", "opencodego", "openrouter", "claude", "openai", "windsurf"]) {
      const glyph = GLYPHS[id];
      const source = PROVIDER_MARKS[id];
      expect(glyph, id).toBeDefined();
      expect(glyph.d, id).toEqual(source.paths);
      expect(glyph.viewBox, id).toBe(source.viewBox);
      expect(glyph.fillRule, id).toBe(source.fillRule);
      expect(glyph.hex, id).toBe("#000000"); // monochrome → remapped to INK by hue
    }
  });

  it("keeps the curated entries ahead of and beside generated data", () => {
    // googlegemini carries brand color on the official sparkle outline.
    expect(GLYPHS.googlegemini.hex).toBe("#8E75B2");
    expect(GLYPHS.googlegemini.viewBox).toBe("0 0 192 192");
    // kimi, hermes live only in CURATED — the generated table skips them.
    expect(PROVIDER_MARKS.kimi).toBeUndefined();
    expect(PROVIDER_MARKS.hermes).toBeUndefined();
    expect(harnessGlyphFor("kimi")).toBe(GLYPHS.kimi);
    expect(harnessGlyphFor("hermes")).toBe(GLYPHS.hermes);
    expect(GLYPHS.hermes.d).toBeUndefined();
    expect(GLYPHS.hermes.imageSrc).toMatch(/^data:image\/png;base64,/);
  });

  it("resolves providers with no monochrome vector to provider-published raster marks", () => {
    for (const id of ["ollama", "deepseek", "perplexity", "warp", "jetbrains", "vertexai", "codebuff"]) {
      const glyph = GLYPHS[id];
      expect(glyph, id).toBeDefined();
      expect(glyph.imageSrc, id).toMatch(/^data:image\//);
      expect(glyph.d, id).toBeUndefined();
    }
  });

  it("keeps providers with no published mark on the monogram fallback", () => {
    for (const id of ["litellm", "crossmodel", "llmproxy", "mimo", "sub2api", "clawrouter", "commandcode", "crof"]) {
      const glyph = GLYPHS[id];
      expect(glyph, id).toBeDefined();
      expect(glyph.d, id).toBeUndefined();
      expect(glyph.imageSrc, id).toBeUndefined();
      expect(glyph.displayName, id).toBeTruthy();
    }
    expect(harnessDisplayName("litellm")).toBe("LiteLLM");
    expect(harnessDisplayName("llmproxy")).toBe("LLM Proxy");
  });
});

describe("harnessGlyphFor", () => {
  it("resolves canonical names case-insensitively, trimmed", () => {
    expect(harnessGlyphFor("claude")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("  KIMI ")).toBe(GLYPHS.kimi);
    expect(harnessGlyphFor("OpenCode")).toBe(GLYPHS.opencode);
    expect(harnessGlyphFor("GROK")).toBe(GLYPHS.grok);
    expect(harnessGlyphFor("Hermes")).toBe(GLYPHS.hermes);
    expect(harnessGlyphFor("Cursor")).toBe(GLYPHS.cursor);
    expect(harnessGlyphFor("windsurf")).toBe(GLYPHS.windsurf);
    // canonical provider ids pass through without aliases
    for (const id of ["ollama", "zed", "warp", "deepseek", "mistral", "perplexity"]) {
      expect(harnessGlyphFor(id), id).toBe(GLYPHS[id]);
    }
  });

  it("resolves documented aliases", () => {
    expect(harnessGlyphFor("agy")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("antigravity")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("antigravity-cli")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("Claude Code")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("claude-code")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("gemini")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("Gemini CLI")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("copilot")).toBe(GLYPHS.copilot);
    expect(harnessGlyphFor("GitHub Copilot")).toBe(GLYPHS.copilot);
    expect(harnessGlyphFor("codex")).toBe(GLYPHS.codex);
    expect(harnessGlyphFor("Codex")).toBe(GLYPHS.codex);
    expect(harnessGlyphFor("ChatGPT")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("chat gpt")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("gpt")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("xAI")).toBe(GLYPHS.grok);
    expect(harnessGlyphFor("amp")).toBe(GLYPHS.amp);
    expect(harnessGlyphFor("ampcode")).toBe(GLYPHS.amp);
    expect(harnessGlyphFor("devin")).toBe(GLYPHS.devin);
    expect(harnessGlyphFor("Cognition")).toBe(GLYPHS.devin);
    expect(harnessGlyphFor("cursor-agent")).toBe(GLYPHS.cursor);
    expect(harnessGlyphFor("cursor agent")).toBe(GLYPHS.cursor);
    expect(harnessGlyphFor("openai")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("open code")).toBe(GLYPHS.opencode);
    expect(harnessGlyphFor("open code go")).toBe(GLYPHS.opencodego);
    expect(harnessGlyphFor("Hermes Agent")).toBe(GLYPHS.hermes);
    expect(harnessGlyphFor("Nous Research")).toBe(GLYPHS.hermes);
    expect(harnessGlyphFor("nous")).toBe(GLYPHS.hermes);
  });

  it("resolves generated provider ids, and chatgpt lands on openai — not codex", () => {
    expect(harnessGlyphFor("opencodego")).toBe(GLYPHS.opencodego);
    expect(harnessGlyphFor("crossmodel")).toBe(GLYPHS.crossmodel);
    expect(harnessGlyphFor("openrouter")).toBe(GLYPHS.openrouter);
    expect(harnessGlyphFor("chatgpt")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("chatgpt")).not.toBe(GLYPHS.codex);
  });

  it("returns undefined for unknown or absent agents", () => {
    expect(harnessGlyphFor(undefined)).toBeUndefined();
    expect(harnessGlyphFor("")).toBeUndefined();
    expect(harnessGlyphFor("   ")).toBeUndefined();
  });

  it("carries generated marks as path arrays on their own viewBox and fillRule", () => {
    // Multi-path provider art keeps every path and its native grid.
    expect(GLYPHS.devin.d).toHaveLength(3);
    expect(GLYPHS.devin.viewBox).toBe("-0.747952 -0.722232 21.495942 21.477469");
    expect(GLYPHS.opencodego.d).toHaveLength(2);
    expect(GLYPHS.opencodego.viewBox).toBe("0 0 512 512");
    expect(GLYPHS.opencodego.fillRule).toBe("evenodd");
    expect(GLYPHS.copilot.d).toHaveLength(2);
    expect(GLYPHS.copilot.viewBox).toBe("0 0 24 24");
    // Single-path provider art on its native grid.
    expect(GLYPHS.claude.viewBox).toBe("0 0 248 248");
    expect(GLYPHS.openai.viewBox).toBe("0 0 24 24");
    expect(GLYPHS.codex.viewBox).toBe("0 0 24 24");
    expect(GLYPHS.codex.d).toEqual(PROVIDER_MARKS.openai.paths);
    expect(GLYPHS.windsurf.viewBox).toBe("0 0 1024 1024");
  });
});

describe("harnessDisplayName", () => {
  it("prefers the glyph display name", () => {
    expect(harnessDisplayName("claude")).toBe("Claude");
    expect(harnessDisplayName("claude code")).toBe("Claude");
    expect(harnessDisplayName("gemini")).toBe("Gemini");
    expect(harnessDisplayName("github copilot")).toBe("Copilot");
    expect(harnessDisplayName("opencode")).toBe("OpenCode");
    expect(harnessDisplayName("opencodego")).toBe("OpenCode Go");
    expect(harnessDisplayName("codex")).toBe("Codex");
    expect(harnessDisplayName("chatgpt")).toBe("OpenAI");
    expect(harnessDisplayName("amp")).toBe("Amp");
    expect(harnessDisplayName("devin")).toBe("Devin");
    expect(harnessDisplayName("  grok ")).toBe("Grok");
    // generated ids with brand casing in the display-name map
    expect(harnessDisplayName("deepseek")).toBe("DeepSeek");
    expect(harnessDisplayName("openrouter")).toBe("OpenRouter");
    // plain ids capitalize
    expect(harnessDisplayName("ollama")).toBe("Ollama");
    expect(harnessDisplayName("zed")).toBe("Zed");
  });

  it("capitalizes glyph-less agents and falls back to \"agent\"", () => {
    expect(harnessDisplayName("aider")).toBe("Aider");
    expect(harnessDisplayName(undefined)).toBe("agent");
    expect(harnessDisplayName("")).toBe("agent");
    expect(harnessDisplayName("  ")).toBe("agent");
  });
});

describe("harnessHue", () => {
  it("keeps official monochrome agent marks consistent across harness aliases", () => {
    for (const agent of ["claude", "codex", "chatgpt", "grok", "hermes"]) {
      expect(harnessHue(agent), agent).toBe(INK);
    }
  });

  it("keeps published colors for providers with colored marks", () => {
    expect(harnessHue("gemini cli")).toBe("#8E75B2");
  });

  it("maps near-black brand marks to house INK so they read on the dark field", () => {
    for (const agent of [
      "kimi",
      "opencode",
      "cursor",
      "copilot",
      "windsurf",
      "grok",
      "codex",
      "chatgpt",
      "hermes",
      "amp",
      "devin",
      // monochrome generated marks remap the same way
      "ollama",
      "deepseek",
      "opencodego",
      "openrouter",
    ]) {
      expect(harnessHue(agent), agent).toBe(INK);
    }
  });

  it("hashes glyph-less agents deterministically over the monogram palette", () => {
    expect(MONOGRAM_HUES).toEqual([HUE.amber, HUE.cyan, HUE.violet, HUE.gold, HUE.indigo, HUE.orange]);
    for (const agent of ["aider", "goose", "unknown-xyz"]) {
      const hue = harnessHue(agent);
      expect(hue).toBe(harnessHue(agent)); // same input → same hue
      expect(MONOGRAM_HUES).toContain(hue);
      expect(hue).not.toBe(HUE.crimson); // crimson is reserved for blockers
    }
    // case/whitespace variants hash to the same hue
    expect(harnessHue(" Aider ")).toBe(harnessHue("aider"));
  });
});

describe("MarksService contract", () => {
  it("exposes the repository through the sync accessor React uses", () => {
    expect(marks.glyphFor("claude")).toBe(GLYPHS.claude);
    expect(marks.displayNameFor("gemini")).toBe("Gemini");
    expect(marks.hueFor("claude")).toBe(INK);
    expect(marks.glyphFor("unknown-xyz")).toBeUndefined();
  });

  it("serves the same implementation through the Marks Tag + MarksLive layer", () => {
    const program = Effect.gen(function* () {
      const service = yield* Marks;
      return {
        glyph: service.glyphFor("claude"),
        name: service.displayNameFor("codex"),
        hue: service.hueFor("gemini"),
      };
    });
    const result = Effect.runSync(Effect.provide(program, MarksLive));
    expect(result.glyph).toBe(GLYPHS.claude);
    expect(result.name).toBe("Codex");
    expect(result.hue).toBe("#8E75B2");
  });
});

describe("markTileFor (HarnessMark resolve step)", () => {
  const sentinel: HarnessGlyph = {
    d: "M0 0h10v10z",
    viewBox: "0 0 10 10",
    hex: "#123456",
    displayName: "Sentinel",
  };
  const stub: MarksService = {
    glyphFor: () => sentinel,
    displayNameFor: () => "Sentinel",
    hueFor: () => "#123456",
  };

  it("flows a substitute MarksService through the tile mapping", () => {
    const tile = markTileFor("whatever", stub);
    expect(tile.glyph).toBe(sentinel);
    expect(tile.hue).toBe("#123456");
    expect(tile.displayName).toBe("Sentinel");
    expect(tile.viewBox).toBe("0 0 10 10");
    expect(tile.paths).toEqual(["M0 0h10v10z"]);
    expect(tile.fillRule).toBe("nonzero");
    expect(tile.known).toBe(true);
  });

  it("resolves a known brand agent against the house repository by default", () => {
    const tile = markTileFor("claude");
    expect(tile.glyph).toBe(GLYPHS.claude);
    expect(tile.hue).toBe(INK);
    expect(tile.displayName).toBe("Claude");
    expect(tile.paths).toEqual(PROVIDER_MARKS.claude.paths);
    expect(tile.viewBox).toBe("0 0 248 248");
    expect(tile.known).toBe(true);
  });

  it("keeps multi-path generated marks as arrays with their own viewBox and fillRule", () => {
    const tile = markTileFor("opencodego");
    expect(tile.paths).toEqual(PROVIDER_MARKS.opencodego.paths);
    expect(tile.viewBox).toBe("0 0 512 512");
    expect(tile.fillRule).toBe("evenodd");
    expect(tile.hue).toBe(INK);
  });

  it("uses the exact embedded vendor asset when a harness publishes a raster icon", () => {
    const tile = markTileFor("hermes");
    expect(tile.imageSrc).toBe(GLYPHS.hermes.imageSrc);
    expect(tile.paths).toEqual([]);
    expect(tile.hue).toBe(INK);
  });

  it("monograms glyph-less agents on their deterministic hue", () => {
    const tile = markTileFor("aider");
    expect(tile.glyph).toBeUndefined();
    expect(tile.known).toBe(true);
    expect(MONOGRAM_HUES).toContain(tile.hue);
    expect(tile.paths).toEqual([]);
    expect(tile.displayName).toBe("Aider");
  });

  it("monograms providers whose glyph carries no artwork", () => {
    const tile = markTileFor("litellm");
    expect(tile.glyph).toBe(GLYPHS.litellm);
    expect(tile.paths).toEqual([]);
    expect(tile.imageSrc).toBeUndefined();
    expect(tile.hue).toBe(INK);
    expect(tile.displayName).toBe("LiteLLM");
  });

  it("dims the absent-agent terminal mark instead of monogramming \"agent\"", () => {
    const tile = markTileFor(undefined);
    expect(tile.glyph).toBeUndefined();
    expect(tile.known).toBe(false);
    expect(tile.hue).toBe(DIM);
    expect(tile.displayName).toBe("agent");
    expect(tile.paths).toEqual([]);
  });
});
