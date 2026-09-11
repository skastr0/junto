import { describe, expect, it } from "vitest";
import {
  enumerateCursorModels,
  parseCursorModelsList,
} from "../src/main/vellum-command/term/templates/enumerate-models";

const LIVE_STDOUT = `Available models

auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
claude-opus-4-8-medium - Claude Opus 4.8 1M Medium
claude-opus-4-8-xhigh - Claude Opus 4.8 1M Extra High
claude-opus-4-8-max - Claude Opus 4.8 1M Max
`;

describe("parseCursorModelsList", () => {
  it("parses header plus id - Label rows", () => {
    const { models } = parseCursorModelsList(LIVE_STDOUT);
    expect(models).toEqual([
      { id: "auto", label: "Auto (default)" },
      { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low" },
      { id: "cursor-grok-4.6-high-fast", label: "Cursor Grok 4.6 Fast" },
      { id: "claude-opus-4-8-medium", label: "Claude Opus 4.8 1M Medium" },
      { id: "claude-opus-4-8-xhigh", label: "Claude Opus 4.8 1M Extra High" },
      { id: "claude-opus-4-8-max", label: "Claude Opus 4.8 1M Max" },
    ]);
  });

  it("skips blank lines", () => {
    const { models } = parseCursorModelsList(
      "\n\nauto - Auto (default)\n\n\ngpt-5.3-codex-low - Codex 5.3 Low\n",
    );
    expect(models).toEqual([
      { id: "auto", label: "Auto (default)" },
      { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low" },
    ]);
  });

  it("fails soft on empty output", () => {
    expect(parseCursorModelsList("").models).toEqual([]);
    expect(parseCursorModelsList("   \n\n").models).toEqual([]);
  });

  it("scrubs ANSI and middots to commas", () => {
    const stdout = [
      "\x1b[1mAvailable models\x1b[0m",
      "",
      "\x1b[36mauto\x1b[0m - Auto \u00B7 default",
    ].join("\n");
    const { models } = parseCursorModelsList(stdout);
    expect(models).toEqual([{ id: "auto", label: "Auto , default" }]);
  });
});

describe("enumerateCursorModels", () => {
  it("fails soft without a runner", async () => {
    const empty = await enumerateCursorModels();
    expect(empty).toMatchObject({ models: [], source: "empty" });
    expect(empty.error).toMatch(/no output/);
  });

  it("uses an injectable runner", async () => {
    const full = await enumerateCursorModels(async () => LIVE_STDOUT);
    expect(full.source).toBe("command");
    expect(full.models[0]?.id).toBe("auto");
  });

  it("fails soft when the runner throws", async () => {
    const result = await enumerateCursorModels(async () => {
      throw new Error("agent missing");
    });
    expect(result).toMatchObject({ models: [], source: "empty" });
    expect(result.error).toBe("agent missing");
  });
});
