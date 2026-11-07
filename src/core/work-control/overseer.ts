/**
 * The core's handlers for the work socket's overseer and overseer.live ops (`OverseerRpcs`). Owned by
 * cli-overseer. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 */
import { OverseerRpcs } from "../../contract/work/overseer";
import { WorkAdmission } from "./seat";

export const OverseerServed = OverseerRpcs.middleware(WorkAdmission);

export const OverseerHandlers = OverseerServed.toLayer(OverseerServed.of({}));
