/** The acceptance areas, in the order the main script runs them. */
import type { AcceptanceArea } from "./area";
import { artifactArea } from "./artifact";
import { automationArea } from "./automation";
import { coreArea } from "./core";
import { deletedArea } from "./deleted";
import { opArea } from "./op";
import { sinceArea } from "./since";
import { taskArea } from "./task";

export const AREAS: ReadonlyArray<AcceptanceArea> = [coreArea, taskArea, sinceArea, opArea, artifactArea, automationArea, deletedArea];
