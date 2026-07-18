// P0 herdr hosts. Easy to extend — discovery is deliberately out of scope.

export interface HerdrHostDef {
  /** Stable product id used in ether.herdr.host and IPC. */
  readonly id: string;
  /** Human label for wizard chrome. */
  readonly label: string;
}

export type HerdrHostId = "local" | "remote-a";

export const HERDR_HOSTS: ReadonlyArray<HerdrHostDef & { readonly id: HerdrHostId }> = [
  { id: "local", label: "local" },
  { id: "remote-a", label: "remote-a" },
] as const;

export const isKnownHerdrHost = (id: string): boolean =>
  HERDR_HOSTS.some((host) => host.id === id);

export class UnknownHerdrHostError extends Error {
  readonly code = "invalid" as const;
  constructor(hostId: string) {
    super(`unknown herdr host: ${hostId} (P0: local | remote-a)`);
    this.name = "UnknownHerdrHostError";
  }
}
