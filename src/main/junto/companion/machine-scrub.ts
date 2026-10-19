/** The credential scrub the phone's machines tab is encoded with: steps 2 to 4 for messages, step 2 for outside names. */
import type { CompanionMachineScrub } from "@shared/companion-machines";
import { scrubMessage, scrubName } from "../credentials/scrub";

export const companionMachineScrub: CompanionMachineScrub = { message: (text) => scrubMessage(text), name: scrubName };
