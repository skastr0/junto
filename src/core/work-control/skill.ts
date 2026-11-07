/**
 * The core's handlers for the work socket's artifact.*, automation.*, references.* and content.stage ops (`SkillRpcs`). Owned by
 * cli-skill. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 */
import { SkillRpcs } from "../../contract/work/skill";
import { WorkAdmission } from "./seat";

export const SkillServed = SkillRpcs.middleware(WorkAdmission);

export const SkillHandlers = SkillServed.toLayer(SkillServed.of({}));
