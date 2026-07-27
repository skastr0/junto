import type { HarnessId } from "../../../../../shared/managed-terminal-templates";
import type { SeatRulePack } from "../types";
import { claudeRules } from "./claude";
import { codexRules } from "./codex";
import { grokRules } from "./grok";
import { hermesRules } from "./hermes";

export { claudeRules } from "./claude";
export { codexRules } from "./codex";
export { grokRules } from "./grok";
export { hermesRules } from "./hermes";

const PACKS: Record<HarnessId, SeatRulePack> = {
  claude: claudeRules,
  codex: codexRules,
  grok: grokRules,
  hermes: hermesRules,
};

export const rulePackFor = (harness: HarnessId): SeatRulePack => PACKS[harness];

