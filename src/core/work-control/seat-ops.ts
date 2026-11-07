/**
 * The core's handlers for the work socket's seat.* and preamble ops (`SeatRpcs`). Owned by
 * cli-identity. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 */
import { SeatRpcs } from "../../contract/work/seat";
import { WorkAdmission } from "./seat";

export const SeatServed = SeatRpcs.middleware(WorkAdmission);

export const SeatHandlers = SeatServed.toLayer(SeatServed.of({}));
