/**
 * The core's handlers for the work socket's ping, doctor, capabilities, onboard, since, offboard, signal.*, op.*, env.report and logs.read ops (`DiscoveryRpcs`). Owned by
 * cli-performance. Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does.
 */
import { DiscoveryRpcs } from "../../contract/work/discovery";
import { WorkAdmission } from "./seat";

export const DiscoveryServed = DiscoveryRpcs.middleware(WorkAdmission);

export const DiscoveryHandlers = DiscoveryServed.toLayer(DiscoveryServed.of({}));
