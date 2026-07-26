import type { SeatHarnessId, SeatRulePack } from "../types";
import { claudeRules } from "./claude";
import { codexRules } from "./codex";
import { grokRules } from "./grok";
import { hermesRules } from "./hermes";

export { claudeRules } from "./claude";
export { codexRules } from "./codex";
export { grokRules } from "./grok";
export { hermesRules } from "./hermes";

const PACKS: Record<SeatHarnessId, SeatRulePack> = {
  claude: claudeRules,
  codex: codexRules,
  grok: grokRules,
  hermes: hermesRules,
};

export const rulePackFor = (harness: SeatHarnessId): SeatRulePack => PACKS[harness];

export const ALL_HARNESS_IDS: readonly SeatHarnessId[] = [
  "claude",
  "codex",
  "grok",
  "hermes",
] as const;

export const isSeatHarnessId = (value: string): value is SeatHarnessId =>
  value === "claude" ||
  value === "codex" ||
  value === "grok" ||
  value === "hermes";
