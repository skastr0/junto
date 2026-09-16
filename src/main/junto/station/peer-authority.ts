import type { Socket } from "node:net";

/**
 * Opaque proof that the Station control server accepted one connection through
 * its owner-only Unix socket.
 *
 * This is local handoff containment, not proof of the original SSH principal.
 * OpenSSH authenticates at its own boundary; Electron main cannot recover that
 * identity from this socket and must authorize every Station API request.
 */
export interface StationControlLocalHandoff {
  readonly _tag: "StationControlLocalHandoff";
}

export interface StationControlLocalHandoffAuthority {
  readonly capture: (
    socket: Socket,
  ) => StationControlLocalHandoff | undefined;
  readonly isCurrent: (
    socket: Socket,
    handoff: StationControlLocalHandoff,
  ) => boolean;
}

/**
 * Bind an unforgeable-in-practice, process-local token to the exact accepted
 * socket. The control server calls `capture` only after it has verified that
 * its leased listener path still names an owner-only Unix socket.
 *
 * The same-user boundary is deliberate: Junto does not claim to isolate an
 * arbitrary malicious process already running as the operator account.
 */
export const makeOwnerLocalStationControlHandoffAuthority =
  (): StationControlLocalHandoffAuthority => {
    const bySocket = new WeakMap<Socket, StationControlLocalHandoff>();
    const issued = new WeakMap<StationControlLocalHandoff, Socket>();

    return Object.freeze({
      capture: (
        socket: Socket,
      ): StationControlLocalHandoff | undefined => {
        if (socket.destroyed) return undefined;
        const existing = bySocket.get(socket);
        if (existing !== undefined) return existing;
        const handoff = Object.freeze({
          _tag: "StationControlLocalHandoff" as const,
        });
        bySocket.set(socket, handoff);
        issued.set(handoff, socket);
        return handoff;
      },
      isCurrent: (
        socket: Socket,
        handoff: StationControlLocalHandoff,
      ): boolean =>
        !socket.destroyed && issued.get(handoff) === socket,
    });
  };
