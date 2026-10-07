import { describe, expect, it } from "vitest";
import {
  isSeatCredentialShape,
  makeSeatCredentialRegistry,
  mintSeatCredential,
} from "../src/main/junto/work/seat-credentials";

const PRINCIPAL = {
  agentKey: "local:worker",
  canvasName: "factory",
  nodeId: "agent-1",
} as const;

describe("seat credential shape", () => {
  it("mints unique prefixed credentials", () => {
    const a = mintSeatCredential();
    const b = mintSeatCredential();
    expect(isSeatCredentialShape(a.credential)).toBe(true);
    expect(isSeatCredentialShape(b.credential)).toBe(true);
    expect(a.credential).not.toBe(b.credential);
    expect(a.generationId).not.toBe(b.generationId);
  });

  it("rejects malformed values", () => {
    expect(isSeatCredentialShape("")).toBe(false);
    expect(isSeatCredentialShape("junto-seat-short")).toBe(false);
    expect(isSeatCredentialShape("wrong-prefix-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(isSeatCredentialShape(" junto-seat-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("seat credential registry", () => {
  it("a minted credential is not valid until published", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    expect(registry.lookup(minted.credential).status).toBe("unknown");
  });

  it("publishes and looks up a live credential", () => {
    const registry = makeSeatCredentialRegistry({ now: () => 1_700_000_000_000 });
    const minted = mintSeatCredential();
    expect(registry.publish(minted, { ...PRINCIPAL })).toBe(true);
    const found = registry.lookup(minted.credential);
    expect(found.status).toBe("live");
    if (found.status === "live") {
      expect(found.principal).toEqual(PRINCIPAL);
      expect(found.generationId).toBe(minted.generationId);
      expect(found.issuedAt).toBe(1_700_000_000_000);
    }
  });

  it("refuses malformed credentials at publish", () => {
    const registry = makeSeatCredentialRegistry();
    expect(registry.publish({ credential: "not-a-credential", generationId: "gen-bad" }, { ...PRINCIPAL })).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("refuses double publish of one credential", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    expect(registry.publish(minted, { ...PRINCIPAL })).toBe(true);
    expect(registry.publish(minted, { ...PRINCIPAL })).toBe(false);
  });

  it("revokes to a tombstone and never reissues the value", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    registry.publish(minted, { ...PRINCIPAL });
    expect(registry.revoke(minted.credential, "replaced")).toBe(true);
    const found = registry.lookup(minted.credential);
    expect(found.status).toBe("revoked");
    if (found.status === "revoked") {
      expect(found.principal).toEqual(PRINCIPAL);
      expect(found.reason).toBe("replaced");
    }
    expect(registry.publish(minted, { ...PRINCIPAL })).toBe(false);
    expect(registry.revoke(minted.credential, "replaced")).toBe(false);
  });

  it("revoking an unknown credential fails without a tombstone", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    expect(registry.revoke(minted.credential, "replaced")).toBe(false);
    expect(registry.lookup(minted.credential).status).toBe("unknown");
    expect(registry.tombstoneSize()).toBe(0);
  });

  it("revokes every live credential of one principal", () => {
    const registry = makeSeatCredentialRegistry();
    const a = mintSeatCredential();
    const b = mintSeatCredential();
    const other = mintSeatCredential();
    registry.publish(a, { ...PRINCIPAL });
    registry.publish(b, { ...PRINCIPAL });
    registry.publish(other, { agentKey: "local:other" });
    expect(registry.revokePrincipal({ ...PRINCIPAL })).toBe(2);
    expect(registry.lookup(a.credential).status).toBe("revoked");
    expect(registry.lookup(b.credential).status).toBe("revoked");
    expect(registry.lookup(other.credential).status).toBe("live");
  });

  it("notifies subscribers on publish and revoke", () => {
    const registry = makeSeatCredentialRegistry();
    const seen: Array<{ type: string; generationId: string }> = [];
    const unsubscribe = registry.subscribe((event) => {
      seen.push({ type: event.type, generationId: event.generationId });
    });
    const minted = mintSeatCredential();
    registry.publish(minted, { ...PRINCIPAL });
    registry.revoke(minted.credential, "seat-closed");
    unsubscribe();
    const again = mintSeatCredential();
    registry.publish(again, { ...PRINCIPAL });
    expect(seen).toEqual([
      { type: "published", generationId: minted.generationId },
      { type: "revoked", generationId: minted.generationId },
    ]);
  });

  it("suspends on detach and reanchors on reattach", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    registry.publish(minted, { ...PRINCIPAL });
    expect(registry.suspend(minted.credential)).toBe(true);
    expect(registry.suspend(minted.credential)).toBe(false);
    const held = registry.lookup(minted.credential);
    expect(held.status).toBe("suspended");
    const reanchored = { ...PRINCIPAL, canvasName: "other", nodeId: "agent-9" };
    expect(registry.reanchor(minted.credential, reanchored)).toBe(true);
    expect(registry.reanchor(minted.credential, reanchored)).toBe(false);
    const live = registry.lookup(minted.credential);
    expect(live.status).toBe("live");
    if (live.status === "live") {
      expect(live.principal).toEqual(reanchored);
      expect(live.generationId).toBe(minted.generationId);
    }
  });

  it("revoked credentials never return via reanchor", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    registry.publish(minted, { ...PRINCIPAL });
    registry.revoke(minted.credential, "offboarded");
    expect(registry.reanchor(minted.credential, { ...PRINCIPAL })).toBe(false);
    expect(registry.suspend(minted.credential)).toBe(false);
    expect(registry.lookup(minted.credential).status).toBe("revoked");
  });

  it("revokePrincipal retires suspended credentials too", () => {
    const registry = makeSeatCredentialRegistry();
    const minted = mintSeatCredential();
    registry.publish(minted, { ...PRINCIPAL });
    registry.suspend(minted.credential);
    expect(registry.revokePrincipal({ ...PRINCIPAL })).toBe(1);
    expect(registry.lookup(minted.credential).status).toBe("revoked");
  });

  it("caps tombstones by evicting the oldest", () => {
    const registry = makeSeatCredentialRegistry({ tombstoneCap: 2 });
    const creds = [mintSeatCredential(), mintSeatCredential(), mintSeatCredential()];
    for (const minted of creds) {
      registry.publish(minted, { ...PRINCIPAL });
      registry.revoke(minted.credential, "replaced");
    }
    expect(registry.tombstoneSize()).toBe(2);
    expect(registry.lookup(creds[0]!.credential).status).toBe("unknown");
    expect(registry.lookup(creds[2]!.credential).status).toBe("revoked");
  });
});
