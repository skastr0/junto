import { describe, expect, it } from "vitest";
import {
  GLYPHS,
  MONOGRAM_HUES,
  harnessDisplayName,
  harnessGlyphFor,
  harnessHue,
} from "../src/renderer/lib/harness-icons";
import { HUE, INK } from "../src/renderer/lib/theme";

describe("harnessGlyphFor", () => {
  it("resolves canonical names case-insensitively, trimmed", () => {
    expect(harnessGlyphFor("claude")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("  KIMI ")).toBe(GLYPHS.kimi);
    expect(harnessGlyphFor("OpenCode")).toBe(GLYPHS.opencode);
    expect(harnessGlyphFor("GROK")).toBe(GLYPHS.grok);
    expect(harnessGlyphFor("Cursor")).toBe(GLYPHS.cursor);
    expect(harnessGlyphFor("windsurf")).toBe(GLYPHS.windsurf);
  });

  it("resolves documented aliases", () => {
    expect(harnessGlyphFor("Claude Code")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("claude-code")).toBe(GLYPHS.claude);
    expect(harnessGlyphFor("gemini")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("Gemini CLI")).toBe(GLYPHS.googlegemini);
    expect(harnessGlyphFor("copilot")).toBe(GLYPHS.githubcopilot);
    expect(harnessGlyphFor("GitHub Copilot")).toBe(GLYPHS.githubcopilot);
    expect(harnessGlyphFor("codex")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("Codex")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("ChatGPT")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("chat gpt")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("gpt")).toBe(GLYPHS.openai);
    expect(harnessGlyphFor("xAI")).toBe(GLYPHS.grok);
    // CodexBar provider ids
    expect(harnessGlyphFor("opencodego")).toBe(GLYPHS.opencode);
    expect(harnessGlyphFor("openai")).toBe(GLYPHS.openai);
  });

  it("returns undefined for unknown or absent agents", () => {
    // amp/ampcode used to resolve to the AMP-pages brand — the wrong company.
    // They now fall through to a monogram tile.
    expect(harnessGlyphFor("amp")).toBeUndefined();
    expect(harnessGlyphFor("AMP")).toBeUndefined();
    expect(harnessGlyphFor("ampcode")).toBeUndefined();
    expect(harnessGlyphFor(undefined)).toBeUndefined();
    expect(harnessGlyphFor("")).toBeUndefined();
    expect(harnessGlyphFor("   ")).toBeUndefined();
  });

  it("carries multi-path marks as an array of d strings on their own viewBox", () => {
    expect(Array.isArray(GLYPHS.grok.d)).toBe(true);
    expect(GLYPHS.grok.d).toHaveLength(4);
    expect(GLYPHS.grok.viewBox).toBe("190 50 460 500");
    expect(typeof GLYPHS.openai.d).toBe("string");
    expect(GLYPHS.openai.viewBox).toBe("0 0 20 20");
    // Single-path marks keep the default 24×24 grid.
    expect(typeof GLYPHS.claude.d).toBe("string");
    expect(GLYPHS.claude.viewBox).toBeUndefined();
  });
});

describe("harnessDisplayName", () => {
  it("prefers the glyph display name", () => {
    expect(harnessDisplayName("claude")).toBe("Claude");
    expect(harnessDisplayName("claude code")).toBe("Claude");
    expect(harnessDisplayName("gemini")).toBe("Gemini");
    expect(harnessDisplayName("github copilot")).toBe("Copilot");
    expect(harnessDisplayName("opencode")).toBe("OpenCode");
    expect(harnessDisplayName("codex")).toBe("OpenAI");
    expect(harnessDisplayName("chatgpt")).toBe("OpenAI");
    expect(harnessDisplayName("  grok ")).toBe("Grok");
  });

  it("capitalizes glyph-less agents and falls back to \"agent\"", () => {
    expect(harnessDisplayName("amp")).toBe("Amp");
    expect(harnessDisplayName("aider")).toBe("Aider");
    expect(harnessDisplayName(undefined)).toBe("agent");
    expect(harnessDisplayName("")).toBe("agent");
    expect(harnessDisplayName("  ")).toBe("agent");
  });
});

describe("harnessHue", () => {
  it("keeps real brand colors", () => {
    expect(harnessHue("claude")).toBe("#D97757");
    expect(harnessHue("gemini cli")).toBe("#8E75B2");
  });

  it("maps near-black brand marks to house INK so they read on the dark field", () => {
    for (const agent of ["kimi", "opencode", "cursor", "copilot", "windsurf", "grok", "codex", "chatgpt"]) {
      expect(harnessHue(agent)).toBe(INK);
    }
  });

  it("hashes glyph-less agents deterministically over the monogram palette", () => {
    expect(MONOGRAM_HUES).toEqual([HUE.amber, HUE.cyan, HUE.violet, HUE.gold, HUE.indigo, HUE.orange]);
    for (const agent of ["amp", "aider", "goose", "unknown-xyz"]) {
      const hue = harnessHue(agent);
      expect(hue).toBe(harnessHue(agent)); // same input → same hue
      expect(MONOGRAM_HUES).toContain(hue);
      expect(hue).not.toBe(HUE.crimson); // crimson is reserved for blockers
    }
    // case/whitespace variants hash to the same hue
    expect(harnessHue(" Aider ")).toBe(harnessHue("aider"));
  });
});
