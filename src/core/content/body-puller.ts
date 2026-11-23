import { Context, type Effect } from "effect";
import type { ContentRef } from "@shared/content";
import type { ContentPullRefused, ResourceReached } from "@shared/content-pull";
import type { InstallationId } from "@shared/installation-id";
import type { CanvasPlacement } from "@shared/work-exchange";
import type { ContentPullFailed, PulledOwner } from "./pull";

/**
 * Bring a resource body here from the machine that edits its canvas and keep
 * it under `owner` (pull.ts). The machine core provides it from
 * `MachineCoreRows.pullBody`; a work handler reads it without importing the
 * runtime. A rig without it pulls nothing.
 */
export class BodyPuller extends Context.Service<BodyPuller, {
  readonly pull: (input: {
    readonly ref: ContentRef;
    readonly owner: PulledOwner;
    readonly reached: ResourceReached;
  }) => Effect.Effect<void, ContentPullRefused | ContentPullFailed>;
  /**
   * This machine's identity and the canvas's placement now, for minting a
   * seat's own-mailbox pull (`seatReachesOwnMail`). Absent on a rig without
   * machine placement; callers fail closed without it.
   */
  readonly placement?: (
    canvasName: string,
  ) => Effect.Effect<{ readonly self: InstallationId; readonly placement: CanvasPlacement } | undefined>;
}>()("@junto/BodyPuller") {}
