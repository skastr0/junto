/**
 * Seat generation credentials — main-issued, env-injected, per-occupant-generation
 * identity for the work control socket.
 *
 * A seat process proves its seat by presenting the credential minted for its
 * generation in the existing work-frame token field. The registry maps that
 * value to a live (seat, generation); revocation is registry invalidation.
 * No process observation happens here: no peer credentials, no ancestry walk,
 * no start-time checks. Lookup is a map read, safe to run on every request.
 *
 * Lifecycle contract: mint before spawn, publish after the live lease confirms
 * the process exists, revoke when the generation ends (offboard ask-accepted,
 * offboard now, rest, seat close). A published value is never reused; a
 * revoked value keeps a bounded tombstone so callers hear "this seat moved on"
 * instead of "unknown credential". Only main publishes; callers only present.
 *
 * A live seat can lose its canvas anchors while its process keeps running
 * (canvas detach) and regain them later (reattach). A replacement value cannot
 * be delivered to a running process, so detach suspends the credential — calls
 * fail closed — and reattach reanchors it to the new principal. Suspended is
 * the only state that returns to live; revoked is terminal.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { ProcessPrincipal } from "../process-identity";

export const SEAT_CREDENTIAL_PREFIX = "junto-seat-";
const SEAT_CREDENTIAL_BYTES = 32;
const SEAT_CREDENTIAL_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_TOMBSTONE_CAP = 1024;

export const isSeatCredentialShape = (value: string): boolean => {
  if (!value.startsWith(SEAT_CREDENTIAL_PREFIX)) return false;
  return SEAT_CREDENTIAL_BODY_PATTERN.test(value.slice(SEAT_CREDENTIAL_PREFIX.length));
};

export type SeatCredentialMint = {
  readonly credential: string;
  readonly generationId: string;
};

export const mintSeatCredential = (
  random: (bytes: number) => string = (bytes) =>
    randomBytes(bytes).toString("base64url"),
  newGenerationId: () => string = randomUUID,
): SeatCredentialMint => ({
  credential: `${SEAT_CREDENTIAL_PREFIX}${random(SEAT_CREDENTIAL_BYTES)}`,
  generationId: newGenerationId(),
});

export type SeatCredentialRevokeReason =
  | "replaced"
  | "seat-closed"
  | "offboarded";

export type SeatCredentialLookup =
  | {
      readonly status: "live";
      readonly principal: ProcessPrincipal;
      readonly generationId: string;
      readonly issuedAt: number;
    }
  | {
      readonly status: "revoked";
      readonly principal: ProcessPrincipal;
      readonly generationId: string;
      readonly reason: SeatCredentialRevokeReason;
    }
  | {
      readonly status: "suspended";
      readonly principal: ProcessPrincipal;
      readonly generationId: string;
    }
  | { readonly status: "unknown" };

export type SeatCredentialEvent =
  | {
      readonly type: "published";
      readonly principal: ProcessPrincipal;
      readonly generationId: string;
    }
  | {
      readonly type: "revoked";
      readonly principal: ProcessPrincipal;
      readonly generationId: string;
    };

export interface SeatCredentialRegistryOptions {
  readonly now?: () => number;
  readonly tombstoneCap?: number;
}

export interface SeatCredentialRegistry {
  readonly publish: (mint: SeatCredentialMint, principal: ProcessPrincipal) => boolean;
  readonly lookup: (credential: string) => SeatCredentialLookup;
  readonly suspend: (credential: string) => boolean;
  readonly reanchor: (credential: string, principal: ProcessPrincipal) => boolean;
  readonly revoke: (credential: string, reason: SeatCredentialRevokeReason) => boolean;
  readonly revokePrincipal: (match: ProcessPrincipal) => number;
  readonly subscribe: (listener: (event: SeatCredentialEvent) => void) => () => void;
  readonly size: () => number;
  readonly tombstoneSize: () => number;
}

type LiveRecord = {
  readonly principal: ProcessPrincipal;
  readonly generationId: string;
  readonly issuedAt: number;
};

type Tombstone = {
  readonly principal: ProcessPrincipal;
  readonly generationId: string;
  readonly reason: SeatCredentialRevokeReason;
};

const samePrincipal = (a: ProcessPrincipal, b: ProcessPrincipal): boolean =>
  a.agentKey === b.agentKey &&
  a.bindingId === b.bindingId &&
  a.canvasName === b.canvasName &&
  a.nodeId === b.nodeId;

export const makeSeatCredentialRegistry = (
  options: SeatCredentialRegistryOptions = {},
): SeatCredentialRegistry => {
  const now = options.now ?? Date.now;
  const tombstoneCap = options.tombstoneCap ?? DEFAULT_TOMBSTONE_CAP;
  const live = new Map<string, LiveRecord>();
  const suspended = new Map<string, LiveRecord>();
  const tombstones = new Map<string, Tombstone>();
  const listeners = new Set<(event: SeatCredentialEvent) => void>();

  const notify = (event: SeatCredentialEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const evictTombstones = (): void => {
    while (tombstones.size > tombstoneCap) {
      const oldest = tombstones.keys().next();
      if (oldest.done) return;
      tombstones.delete(oldest.value);
    }
  };

  const tombstone = (credential: string, record: LiveRecord, reason: SeatCredentialRevokeReason): void => {
    live.delete(credential);
    suspended.delete(credential);
    tombstones.set(
      credential,
      Object.freeze({
        principal: record.principal,
        generationId: record.generationId,
        reason,
      }),
    );
    evictTombstones();
    notify({ type: "revoked", principal: record.principal, generationId: record.generationId });
  };

  return {
    publish: (mint: SeatCredentialMint, principal: ProcessPrincipal): boolean => {
      if (!isSeatCredentialShape(mint.credential)) return false;
      if (live.has(mint.credential) || suspended.has(mint.credential) || tombstones.has(mint.credential)) {
        return false;
      }
      const record: LiveRecord = {
        principal: Object.freeze({ ...principal }),
        generationId: mint.generationId,
        issuedAt: now(),
      };
      live.set(mint.credential, Object.freeze(record));
      notify({ type: "published", principal: record.principal, generationId: mint.generationId });
      return true;
    },
    lookup: (credential: string): SeatCredentialLookup => {
      const record = live.get(credential);
      if (record !== undefined) {
        return {
          status: "live",
          principal: record.principal,
          generationId: record.generationId,
          issuedAt: record.issuedAt,
        };
      }
      const held = suspended.get(credential);
      if (held !== undefined) {
        return {
          status: "suspended",
          principal: held.principal,
          generationId: held.generationId,
        };
      }
      const tomb = tombstones.get(credential);
      if (tomb !== undefined) {
        return {
          status: "revoked",
          principal: tomb.principal,
          generationId: tomb.generationId,
          reason: tomb.reason,
        };
      }
      return { status: "unknown" };
    },
    suspend: (credential: string): boolean => {
      const record = live.get(credential);
      if (record === undefined) return false;
      live.delete(credential);
      suspended.set(credential, record);
      notify({ type: "revoked", principal: record.principal, generationId: record.generationId });
      return true;
    },
    reanchor: (credential: string, principal: ProcessPrincipal): boolean => {
      const record = suspended.get(credential);
      if (record === undefined) return false;
      const next: LiveRecord = {
        principal: Object.freeze({ ...principal }),
        generationId: record.generationId,
        issuedAt: record.issuedAt,
      };
      suspended.delete(credential);
      live.set(credential, Object.freeze(next));
      notify({ type: "published", principal: next.principal, generationId: next.generationId });
      return true;
    },
    revoke: (credential: string, reason: SeatCredentialRevokeReason): boolean => {
      const record = live.get(credential) ?? suspended.get(credential);
      if (record === undefined) return false;
      tombstone(credential, record, reason);
      return true;
    },
    revokePrincipal: (match: ProcessPrincipal): number => {
      let revoked = 0;
      for (const [credential, record] of live) {
        if (!samePrincipal(record.principal, match)) continue;
        tombstone(credential, record, "seat-closed");
        revoked += 1;
      }
      for (const [credential, record] of suspended) {
        if (!samePrincipal(record.principal, match)) continue;
        tombstone(credential, record, "seat-closed");
        revoked += 1;
      }
      return revoked;
    },
    subscribe: (listener: (event: SeatCredentialEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    size: () => live.size,
    tombstoneSize: () => tombstones.size,
  };
};

/** Shared main-process registry. Every control plane shares one map. */
let sharedRegistry: SeatCredentialRegistry | undefined;

export const getSeatCredentialRegistry = (): SeatCredentialRegistry => {
  if (sharedRegistry === undefined) sharedRegistry = makeSeatCredentialRegistry();
  return sharedRegistry;
};

/** Test seam: replace the shared registry (or pass undefined to reset). */
export const setSeatCredentialRegistryForTests = (
  registry: SeatCredentialRegistry | undefined,
): void => {
  sharedRegistry = registry;
};
