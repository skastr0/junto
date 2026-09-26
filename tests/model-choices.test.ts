import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  arrangeModels,
  orderModels,
} from "../src/renderer/components/node-palette/model-choices";
import {
  applySettingsPatch,
  defaultSettings,
  harnessPrefsFor,
  HarnessInstancePrefs,
  RECENT_MODELS_MAX,
  rememberRecentModel,
} from "../src/shared/settings";

const model = (id: string, label = id) => ({ id, label });
const pi = [
  model("gpt-5.5"),
  model("claude-haiku-4.5"),
  model("gpt-5.4-mini"),
  model("gpt-5.10"),
  model("kimi-k3"),
  model("gpt-5.4"),
];

describe("model column order", () => {
  it("keeps aliases and a harness's own cache in the harness's order", () => {
    const aliases = [model("default"), model("opus"), model("sonnet"), model("haiku")];
    expect(orderModels(aliases, "aliases")).toEqual(aliases);
    expect(orderModels(pi, "cache")).toEqual(pi);
  });

  it("sorts a list a CLI command printed by label, numbers as numbers", () => {
    expect(orderModels(pi, "command").map((m) => m.id)).toEqual([
      "claude-haiku-4.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.10",
      "kimi-k3",
    ]);
  });
});

describe("arrangeModels", () => {
  it("lists recent picks first, newest first, and never twice", () => {
    const arranged = arrangeModels(pi, ["kimi-k3", "gpt-5.4"], "");
    expect(arranged.recent.map((m) => m.id)).toEqual(["kimi-k3", "gpt-5.4"]);
    expect(arranged.rest.map((m) => m.id)).toEqual(["gpt-5.5", "claude-haiku-4.5", "gpt-5.4-mini", "gpt-5.10"]);
  });

  it("skips a recent pick the harness no longer offers", () => {
    expect(arrangeModels(pi, ["retired-model", "kimi-k3"], "").recent.map((m) => m.id)).toEqual(["kimi-k3"]);
  });

  it("replaces recents and the list with one ranked result while searching", () => {
    const arranged = arrangeModels(pi, ["kimi-k3"], "54m");
    expect(arranged.recent).toEqual([]);
    expect(arranged.rest.map((m) => m.id)).toEqual(["gpt-5.4-mini"]);
    expect(arrangeModels(pi, [], "haiku").rest.map((m) => m.id)).toEqual(["claude-haiku-4.5"]);
    expect(arrangeModels(pi, [], "zzz").rest).toEqual([]);
  });

  it("matches a model's id as well as its label", () => {
    const labelled = [model("claude-opus-5-5", "Opus 5.5"), model("claude-sonnet-5", "Sonnet 5")];
    expect(arrangeModels(labelled, [], "claude-son").rest.map((m) => m.label)).toEqual(["Sonnet 5"]);
  });
});

describe("recent models setting", () => {
  it("moves a pick to the front and keeps a few", () => {
    expect(rememberRecentModel(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: 9 }, (_, i) => `m${i}`);
    expect(rememberRecentModel(many, "new")).toHaveLength(RECENT_MODELS_MAX);
    expect(rememberRecentModel(undefined, " opus ")).toEqual(["opus"]);
  });

  it("is stored per harness beside its other preferences, and [] clears it", () => {
    const base = applySettingsPatch(defaultSettings(), {
      harnesses: { byHarness: { claude: { model: "opus" } } },
    });
    const withRecent = applySettingsPatch(base, {
      harnesses: { byHarness: { claude: { recentModels: ["sonnet", "sonnet", " opus "] } } },
    });
    expect(harnessPrefsFor(withRecent, "claude")).toEqual({ model: "opus", recentModels: ["sonnet", "opus"] });
    expect(harnessPrefsFor(withRecent, "pi").recentModels).toBeUndefined();
    const cleared = applySettingsPatch(withRecent, {
      harnesses: { byHarness: { claude: { recentModels: [] } } },
    });
    expect(harnessPrefsFor(cleared, "claude")).toEqual({ model: "opus" });
  });

  it("decodes a stored row written before the key existed", () => {
    expect(Schema.decodeUnknownSync(HarnessInstancePrefs)({ model: "opus" })).toEqual({ model: "opus" });
  });
});
