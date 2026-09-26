import type { ManagedTerminalModelOption, ManagedTerminalModelsResult } from "@shared/ipc";
import { rankMatches } from "../../lib/fuzzy-match";

/**
 * How the model column lays out its choices: the harness's defaults first
 * (the same as clicking the agent), then the models picked recently on this
 * harness, then everything else. A search replaces the recents and the list
 * with one ranked list.
 */

/** A model column this long gets a search field; shorter ones keep type-ahead. */
export const MODEL_SEARCH_MIN = 7;

export type ArrangedModels = {
  readonly recent: readonly ManagedTerminalModelOption[];
  readonly rest: readonly ManagedTerminalModelOption[];
};

const byLabel = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Aliases and a harness's own model cache (Claude, Codex) come in the order
 * the harness chose; a list printed by a CLI command (Pi's providers, one
 * after another) does not, so it reads alphabetically, numbers compared as
 * numbers.
 */
export const orderModels = (
  models: readonly ManagedTerminalModelOption[],
  source: ManagedTerminalModelsResult["source"] | undefined,
): readonly ManagedTerminalModelOption[] =>
  source === "command"
    ? [...models].sort((a, b) => byLabel.compare(a.label, b.label))
    : models;

export const arrangeModels = (
  models: readonly ManagedTerminalModelOption[],
  recentIds: readonly string[] | undefined,
  query: string,
): ArrangedModels => {
  if (query.trim()) {
    const ranked = rankMatches(models, query, (model) => ({
      identity: model.label === model.id ? [model.label] : [model.label, model.id],
      ...(model.description ? { metadata: [model.description] } : {}),
    }));
    return { recent: [], rest: ranked.map((row) => row.item) };
  }
  const recent: ManagedTerminalModelOption[] = [];
  for (const id of recentIds ?? []) {
    const model = models.find((candidate) => candidate.id === id);
    if (model && !recent.includes(model)) recent.push(model);
  }
  return { recent, rest: models.filter((model) => !recent.includes(model)) };
};
