import type { HarnessId } from "../../../../../shared/managed-terminal-templates";
import type { SeatRulePack } from "../types";
import { agyRules } from "./agy";
import { ampRules } from "./amp";
import { fxRules } from "./fx";
import { ompRules } from "./omp";
import { claudeRules } from "./claude";
import { codexRules } from "./codex";
import { cursorRules } from "./cursor";
import { devinRules } from "./devin";
import { grokRules } from "./grok";
import { hermesRules } from "./hermes";
import { kimiRules } from "./kimi";
import { museRules } from "./muse";
import { piRules } from "./pi";
import { primeAgentRules } from "./prime-agent";

export { agyRules } from "./agy";
export { ampRules } from "./amp";
export { fxRules } from "./fx";
export { ompRules } from "./omp";
export { claudeRules } from "./claude";
export { codexRules } from "./codex";
export { cursorRules } from "./cursor";
export { devinRules } from "./devin";
export { grokRules } from "./grok";
export { hermesRules } from "./hermes";
export { kimiRules } from "./kimi";
export { museRules } from "./muse";
export { piRules } from "./pi";
export { primeAgentRules } from "./prime-agent";

const PACKS: Record<HarnessId, SeatRulePack> = {
  agy: agyRules,
  amp: ampRules,
  fx: fxRules,
  omp: ompRules,
  claude: claudeRules,
  codex: codexRules,
  cursor: cursorRules,
  devin: devinRules,
  grok: grokRules,
  hermes: hermesRules,
  kimi: kimiRules,
  muse: museRules,
  pi: piRules,
  "prime-agent": primeAgentRules,
};

export const rulePackFor = (harness: HarnessId): SeatRulePack => PACKS[harness];

