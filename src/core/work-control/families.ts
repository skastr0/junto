/**
 * Every group the work socket serves through RPC, and the Layer of their
 * handlers. Each family's files are its own seat's; this list is cli-lead's,
 * and names every family already, so a seat writes only its own two files.
 */
import { Layer } from "effect";
import { DiscoveryHandlers, DiscoveryServed } from "./discovery";
import { MsgHandlers, MsgServed } from "./msg";
import { OverseerHandlers, OverseerServed } from "./overseer";
import { SeatHandlers, SeatServed } from "./seat-ops";
import { SkillHandlers, SkillServed } from "./skill";
import { TaskHandlers, TaskServed } from "./task";

/** A group here without its handlers in `WorkHandlers` fails the core's compile. */
export const WorkServed = MsgServed.merge(TaskServed, SeatServed, SkillServed, DiscoveryServed, OverseerServed);

export const WorkHandlers = Layer.mergeAll(MsgHandlers, TaskHandlers, SeatHandlers, SkillHandlers, DiscoveryHandlers, OverseerHandlers);
