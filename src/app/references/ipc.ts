/**
 * Main's handlers of the window's references group
 * (src/contract/window/references.ts): the writes go to the core's group as
 * they are, and the reads are follow streams over the core's notice. The
 * store lives with the core and the operator is the author; what the window
 * sends is decoded closed by the group's own schemas, here and at the core.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ReferencePlace, ReferencesChangedEvent } from "@shared/references";
import { ReferencesCore } from "../../contract/core/references";
import { ReferencesForwarded, ReferencesWindowRpcs } from "../../contract/window/references";
import { following, forwardTo, fromCore } from "../window/ipc";

/** Whether a notice names a reference at this place: an app-wide one carries no canvas. */
const atPlace = (event: ReferencesChangedEvent, place: ReferencePlace): boolean =>
  event.kind === "reference" &&
  (place.kind === "app"
    ? event.canvasName === undefined
    : event.canvasName === place.canvasName && event.regionId === place.regionId);

export const ReferencesWindowHandlers = ReferencesWindowRpcs.toLayer(
  Effect.gen(function* () {
    const references = yield* ReferencesCore;
    const changed = IPC_CHANNELS.referencesChanged;
    return {
      ...forwardTo(ReferencesForwarded, references),
      ReferencesBriefingFollow: () =>
        following(changed, fromCore(references.ReferencesBriefingRead()), (event) => event.kind === "briefing"),
      ReferencesListFollow: ({ place }) =>
        following(changed, fromCore(references.ReferencesList({ place })), (event) => atPlace(event, place)),
      ReferencesReadFollow: ({ place, name }) =>
        following(
          changed,
          fromCore(references.ReferencesRead({ place, name })),
          (event) => atPlace(event, place) && event.kind === "reference" && event.name === name,
        ),
    };
  }),
);
