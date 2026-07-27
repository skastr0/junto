import type { Socket } from "node:net";
import { Effect, type Context } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import type { RemoteHost } from "@shared/remote-hosts";
import type { StationRole } from "@shared/station";
import type { BrowserSessionService } from "./sessions";
import type { PageTargetResolver } from "./page-target";
import type { BrowserStationAdmissionAuthority } from "./station-admission";
import type { StationBrowserOriginControlRoute } from "./control";
import type { SshTransport } from "../ssh";
import {
  makeAgentStationBrowserRouteAdmission,
  StationBrowserOriginAdmissionError,
  StationBrowserReplayCache,
} from "./station-delegation";
import {
  makeStationBrowserArtifactStore,
  makeStationBrowserLocalClient,
  makeStationBrowserTargetExecutor,
  currentStationBrowserGeneration,
} from "./station-target-executor";
import { makeStationBrowserTargetPolicy } from "./station-target-policy";
import { makeStationBrowserRouter } from "./station-router";
import { StationBrowserTrustRepository } from "./station-trust";
import {
  makeStationBrowserWrapper,
  type StationBrowserWrapper,
} from "./station-wrapper";

export interface StationBrowserRuntimeRoutes {
  readonly stationBrowserOrigin?: StationBrowserOriginControlRoute;
  readonly stationBrowserWrapper?: StationBrowserWrapper;
}

export interface StationBrowserRuntimeDeps {
  readonly home: string;
  readonly trust: Context.Tag.Service<
    typeof StationBrowserTrustRepository
  >;
  readonly sessions: BrowserSessionService;
  readonly readCanvas: (name: string) => Promise<CanvasDoc | undefined>;
  readonly resolvePageTarget: PageTargetResolver;
  readonly stationAdmission: Pick<
    BrowserStationAdmissionAuthority,
    "admit"
  >;
  readonly hosts: () => ReadonlyArray<RemoteHost>;
  readonly ssh: typeof SshTransport.Service;
}

export class StationBrowserRuntimeCompositionError extends Error {
  override readonly name = "StationBrowserRuntimeCompositionError";

  constructor() {
    super("station browser runtime authority is unavailable");
  }
}

const currentIdentityMatches = (
  sessions: BrowserSessionService,
  expected: Readonly<{ hostId: string; role: StationRole }>,
): boolean => {
  const current = sessions.stationIdentity();
  return (
    current?.hostId === expected.hostId &&
    current.role === expected.role &&
    sessions.admitAutomationHost(expected.hostId).ok
  );
};

/**
 * Builds the two LX-015 product paths from host-local application authority.
 *
 * Command Center gets the origin router (including its direct local branch).
 * Remote gets only the signed target wrapper. A live role/host change revokes
 * either path until restart; it never promotes the opposite role in place.
 */
export const prepareStationBrowserRuntimeRoutes = async (
  deps: StationBrowserRuntimeDeps,
): Promise<StationBrowserRuntimeRoutes> => {
  const identity = deps.sessions.stationIdentity();
  if (
    identity === undefined ||
    !deps.sessions.admitAutomationHost(identity.hostId).ok
  ) {
    // Onboarding and temporarily-invalid station settings must not prevent
    // the rest of Vellum from starting. The closed result publishes neither
    // station route; once a station is configured, restart establishes the
    // role-specific authority from a clean composition boundary.
    return Object.freeze({});
  }

  if (identity.role === "command-center") {
    // Validate custody before the control socket can become reachable.
    await Effect.runPromise(
      deps.trust.loadOrCreateOriginKey(identity.hostId),
    );
  } else {
    // A missing pin is an allowed, closed state. A malformed ledger is not.
    await Effect.runPromise(deps.trust.loadPinnedTrust);
  }

  const targetPolicy = makeStationBrowserTargetPolicy({
    stationId: identity.hostId,
    readCanvas: deps.readCanvas,
    admitStation: deps.stationAdmission.admit,
    browserReady: () => currentIdentityMatches(deps.sessions, identity),
    currentGeneration: (request) =>
      currentStationBrowserGeneration(deps.sessions, request),
  });
  const targetExecutor = makeStationBrowserTargetExecutor({
    stationId: identity.hostId,
    role: identity.role,
    sessions: deps.sessions,
    resolvePageTarget: deps.resolvePageTarget,
    discoverPages: targetPolicy.discoverPages,
    artifacts: makeStationBrowserArtifactStore(deps.home),
  });

  if (identity.role === "remote") {
    return Object.freeze({
      stationBrowserWrapper: makeStationBrowserWrapper({
        trust: () => Effect.runPromise(deps.trust.loadPinnedTrust),
        verification: targetPolicy.verification,
        replays: new StationBrowserReplayCache(),
        execute: targetExecutor,
      }),
    });
  }

  const router = makeStationBrowserRouter({
    stationId: identity.hostId,
    hosts: deps.hosts,
    resolvePageHost: async (pageRef) => {
      const resolved = await deps.resolvePageTarget(pageRef);
      return resolved.ok ? { hostId: resolved.data.hostId } : undefined;
    },
    local: makeStationBrowserLocalClient(identity.hostId, targetExecutor),
    ssh: deps.ssh,
    signingIdentity: async () => {
      if (!currentIdentityMatches(deps.sessions, identity)) {
        throw new StationBrowserRuntimeCompositionError();
      }
      const key = await Effect.runPromise(
        deps.trust.loadOrCreateOriginKey(identity.hostId),
      );
      return { keyId: key.keyId, privateKey: key.privateKey };
    },
  });

  return Object.freeze({
    stationBrowserOrigin: Object.freeze({
      router,
      admissionForSocket: (socket: Socket) => {
        if (!currentIdentityMatches(deps.sessions, identity)) {
          throw new StationBrowserOriginAdmissionError(
            "wrong_host",
            "station browser origin identity is no longer current",
          );
        }
        return makeAgentStationBrowserRouteAdmission({
          stationId: identity.hostId,
          socket,
          readCanvas: deps.readCanvas,
        });
      },
    }),
  });
};
