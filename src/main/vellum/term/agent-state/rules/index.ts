import type { HarnessId } from "../../../../../shared/managed-terminal-templates";
import type { SeatRulePack } from "../types";
import { claudeRules } from "./claude";
import { codexRules } from "./codex";
import { devinRules } from "./devin";
import { grokRules } from "./grok";
import { hermesRules } from "./hermes";
import { kimiRules } from "./kimi";
import { museRules } from "./muse";
import { piRules } from "./pi";
import { primeAgentRules } from "./prime-agent";

export { claudeRules } from "./claude";
export { codexRules } from "./codex";
export { devinRules } from "./devin";
export { grokRules } from "./grok";
export { hermesRules } from "./hermes";
export { kimiRules } from "./kimi";
export { museRules } from "./muse";
export { piRules } from "./pi";
export { primeAgentRules } from "./prime-agent";

const PACKS: Record<HarnessId, SeatRulePack> = {
  claude: claudeRules,
  codex: codexRules,
  devin: devinRules,
  grok: grokRules,
  hermes: hermesRules,
  kimi: kimiRules,
  muse: museRules,
  pi: piRules,
  "prime-agent": primeAgentRules,
};

export const rulePackFor = (harness: HarnessId): SeatRulePack => PACKS[harness];

