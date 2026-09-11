import { Context, Layer } from "effect";

// Cut 1 seam (S5): host reachability for the "gone" honesty story (I20 —
// an unreachable Station reads "host unreachable — last intent stands",
// never stopped/revoked/compromised). Null producer reports every host up;
// the fleet lane binds the real per-Station liveness check later without
// touching consumers. Interface + null producer only — any implementation
// beyond null is out of scope for this cut.

export interface HostLivenessService {
  readonly isReachable: (hostId: string) => boolean;
}

export class HostLiveness extends Context.Service<HostLiveness,
  HostLivenessService>()("@vellum-command/HostLiveness") {}

/** Host always up — the fleet lane binds the real check later. */
export const nullHostLiveness: HostLivenessService = {
  isReachable: () => true,
};

export const HostLivenessNull = Layer.succeed(HostLiveness, nullHostLiveness);
