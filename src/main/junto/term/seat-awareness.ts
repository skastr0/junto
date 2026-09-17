/**
 * Seat-awareness composition — the app-side wiring of the advisory sidecar.
 *
 * The awareness module (`./awareness/`) is deliberately authority-free: it sees
 * an observation plane, a seat-facts port, and a projection port, and it cannot
 * reach a seat, the drive, the canvas, or IPC. This file is the one place those
 * real dependencies are bound, so the sidecar runs in the app while the module
 * stays a pure advisory plane.
 *
 * Two things are decided here, and both are display-only:
 *
 *   1. **Enrollment.** A discovered environment key is not consent. The gate is
 *      off unless the operator enrolled it in settings, with a dev override
 *      (`JUNTO_AWARENESS=on|off`) for local testing. Off means no Jev client is
 *      constructed at all, and every observed binding gets one judgment-free
 *      `unavailable` notice with reason `not_configured`, so the card says the
 *      sidecar is off instead of leaving NOT ASSESSED to read as "pending". On
 *      with no key is a different fact and publishes `missing_key`.
 *
 *   2. **The ports.** Deterministic seat facts come from `seatStateRuntime`
 *      (harness, control revision, attention, the current stall episode), and
 *      the projection is the real `selectAwarenessInput`, so the digest the
 *      scheduler caches on is the same normalization the renderer compares.
 *
 * The layer is built to run with a disabled model: a missing key constructs no
 * client and publishes honest notices rather than failing to wire. Nothing here
 * blocks terminal startup or automation, and stopping the plane retires every
 * seat's work through the runtime's own finalizer.
 */

import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { Settings } from "@shared/settings";
import type { SeatAwarenessEvent } from "@renderer/lib/seat-awareness-contract";
import { seatStateRuntime } from "./agent-state";
import { terminalObserverPlane } from "./observer";
import { seatAwarenessEventsForAdvisory } from "./awareness/awareness-wire";
import {
  AwarenessRuntime,
  makeAwarenessLayer,
  type AwarenessObservationPlane,
} from "./awareness/runtime";
import type {
  AwarenessAdvisory,
  AwarenessProjectionPort,
  AwarenessSeatFacts,
  AwarenessSeatPort,
} from "./awareness/scheduler";
import { selectAwarenessInput } from "./awareness/select-input";

// ---------------------------------------------------------------------------
// Enrollment gate
// ---------------------------------------------------------------------------

/** Dev override. `on` forces enrollment, `off` forces the disabled notice. */
export const SEAT_AWARENESS_ENV = "JUNTO_AWARENESS";
/** The provider key. Discovered here; enrollment is still a separate decision. */
export const SEAT_AWARENESS_API_KEY_ENV = "TYPESAFE_API_KEY";

export type SeatAwarenessGateSource = "env-on" | "env-off" | "settings" | "default";

/**
 * Resolve the enrollment gate. The environment override wins so a developer can
 * flip the sidecar without editing durable settings; absent an override, only
 * an explicit settings enrollment turns it on. Anything else is off.
 */
export const resolveSeatAwarenessGate = (input: {
  readonly env: string | undefined;
  readonly enrolled: boolean | undefined;
}): { readonly enabled: boolean; readonly source: SeatAwarenessGateSource } => {
  const env = input.env?.trim().toLowerCase();
  if (env === "on") return { enabled: true, source: "env-on" };
  if (env === "off") return { enabled: false, source: "env-off" };
  if (input.enrolled === true) return { enabled: true, source: "settings" };
  return { enabled: false, source: "default" };
};

/** The settings enrollment flag. Absent ≡ off (the product default). */
export const seatAwarenessEnrolled = (settings: Settings): boolean =>
  settings.advanced.seatAwareness === true;

export const seatAwarenessApiKey = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const key = env[SEAT_AWARENESS_API_KEY_ENV]?.trim();
  return key === undefined || key === "" ? undefined : key;
};

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The real evidence projection: one normalization, the scheduler's own. */
export const awarenessProjectionPort = (): AwarenessProjectionPort => ({
  project: ({ window }) => ({ state: selectAwarenessInput(window) }),
});

export type SeatStatePortHandle = {
  readonly port: AwarenessSeatPort;
  readonly dispose: () => void;
};

/**
 * Deterministic seat facts from the live seat-state runtime.
 *
 * `controlRevision` is maintained here as a per-binding monotonic counter fed
 * by the runtime's own event and composer streams: the scheduler uses it to
 * notice a material control transition without re-asking on a heartbeat. The
 * episode identity is the current stall, one per distinct stall.
 */
export const makeSeatStatePort = (): SeatStatePortHandle => {
  const revision = new Map<string, number>();
  const episodeByBinding = new Map<string, string>();
  let episodeSeq = 0;
  const bump = (bindingId: string): void => {
    revision.set(bindingId, (revision.get(bindingId) ?? 0) + 1);
  };
  const offEvent = seatStateRuntime.subscribe((event) => bump(event.bindingId));
  const offComposer = seatStateRuntime.subscribeComposerVerdict((bindingId) =>
    bump(bindingId),
  );
  const port: AwarenessSeatPort = {
    facts: (bindingId): AwarenessSeatFacts => {
      const slot = seatStateRuntime.machine.getSlot(bindingId);
      let episode: string | undefined;
      if (seatStateRuntime.isTurnStalled(bindingId)) {
        const existing = episodeByBinding.get(bindingId);
        if (existing !== undefined) {
          episode = existing;
        } else {
          episodeSeq += 1;
          episode = `stalled:${episodeSeq}`;
          episodeByBinding.set(bindingId, episode);
        }
      } else {
        episodeByBinding.delete(bindingId);
      }
      return {
        harness: slot?.harness ?? "",
        controlRevision: revision.get(bindingId) ?? 0,
        attention: seatStateRuntime.getState(bindingId) === "attention",
        episode,
      };
    },
  };
  return {
    port,
    dispose: () => {
      offEvent();
      offComposer();
      revision.clear();
      episodeByBinding.clear();
    },
  };
};

// ---------------------------------------------------------------------------
// Gate-off notice
// ---------------------------------------------------------------------------

/**
 * One judgment-free notice for an observed binding while enrollment is off.
 * There is no observation and no window, so the assessment carries no verdict;
 * `not_configured` is the reason the card names.
 */
export const notConfiguredAdvisory = (bindingId: string): AwarenessAdvisory => ({
  bindingId,
  epoch: undefined,
  assessmentId: undefined,
  assessment: undefined,
  absences: [],
  unansweredConcerns: [],
  evidenceLines: [],
  evidenceDigest: undefined,
  windowDigest: undefined,
  windowCapturedAt: undefined,
  availability: "unavailable",
  unavailableReason: "not_configured",
  status: "disabled",
  reason: "seat awareness is not enrolled",
  pending: false,
  trigger: undefined,
});

// ---------------------------------------------------------------------------
// Plane
// ---------------------------------------------------------------------------

export type SeatAwarenessPlaneStartOptions = {
  readonly enabled: boolean;
  /** Discovered key. Ignored entirely while enrollment is off. */
  readonly apiKey?: string | undefined;
  /** Test seam: the observation plane. Production uses the terminal plane. */
  readonly plane?: AwarenessObservationPlane | undefined;
  /** Test seam: the model transport. Production constructs the SDK client. */
  readonly fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  readonly now?: (() => number) | undefined;
};

export type SeatAwarenessPlane = {
  /** Idempotent. Subscribes and replays live seats; never blocks a caller. */
  readonly start: (options: SeatAwarenessPlaneStartOptions) => void;
  readonly stop: () => void;
  readonly subscribe: (listener: (event: SeatAwarenessEvent) => void) => () => void;
  /** Latest events per binding, for renderer-restart hydration. */
  readonly currentEvents: () => ReadonlyArray<SeatAwarenessEvent>;
  readonly isEnabled: () => boolean;
};

export const makeSeatAwarenessPlane = (): SeatAwarenessPlane => {
  const listeners = new Set<(event: SeatAwarenessEvent) => void>();
  const latestByBinding = new Map<string, ReadonlyArray<SeatAwarenessEvent>>();
  let started = false;
  let enabled = false;
  let teardown: (() => void) | undefined;

  const publish = (advisory: AwarenessAdvisory, at: number): void => {
    const events = seatAwarenessEventsForAdvisory(advisory, at);
    if (events.length === 0) return;
    latestByBinding.set(advisory.bindingId, events);
    for (const listener of listeners) {
      for (const event of events) {
        try {
          listener(event);
        } catch (error) {
          // A renderer-facing listener fault must never reach the observer.
          console.error("[seat-awareness] listener failed:", error);
        }
      }
    }
  };

  return {
    start: (options) => {
      if (started) return;
      started = true;
      enabled = options.enabled;
      const plane = options.plane ?? terminalObserverPlane;
      const now = options.now ?? Date.now;

      if (!options.enabled) {
        // Enrollment off: no client, no scheduler. Every observed binding is
        // owed exactly one notice naming why there is no assessment.
        const unsubscribe = plane.subscribeAll((snapshot) => {
          if (latestByBinding.has(snapshot.bindingId)) return;
          publish(notConfiguredAdvisory(snapshot.bindingId), now());
        });
        teardown = () => unsubscribe();
        return;
      }

      const seats = makeSeatStatePort();
      const scope = Scope.makeUnsafe("sequential");
      const context = Effect.runSync(
        Layer.buildWithScope(
          makeAwarenessLayer({
            plane,
            model: {
              apiKey: options.apiKey,
              ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            },
            seats: seats.port,
            projection: awarenessProjectionPort(),
          }),
          scope,
        ),
      );
      const runtime = Context.get(context, AwarenessRuntime);
      const unsubscribe = runtime.subscribe((advisory) => publish(advisory, now()));
      runtime.start();
      teardown = () => {
        unsubscribe();
        runtime.stop();
        seats.dispose();
        Effect.runSync(Scope.close(scope, Exit.void));
      };
    },
    stop: () => {
      if (!started) return;
      teardown?.();
      teardown = undefined;
      started = false;
      enabled = false;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    currentEvents: () => [...latestByBinding.values()].flat(),
    isEnabled: () => enabled,
  };
};

/** Process singleton. Started once with the terminal plane; stopped on quit. */
export const seatAwarenessPlane = makeSeatAwarenessPlane();
