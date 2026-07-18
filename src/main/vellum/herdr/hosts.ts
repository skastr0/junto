// Herdr hosts resolve from the durable remote-host registry (~/.vellum/hosts.json).
// Defaults seed local + remote-a so existing fleets keep working without config.

import {
  findHostById,
  hostsWithCapability,
} from "../hosts/snapshot";

export interface HerdrHostDef {
  /** Stable product id used in ether.herdr.host and IPC. */
  readonly id: string;
  /** Human label for wizard chrome. */
  readonly label: string;
}

/** Host ids are open strings; membership is validated against the registry. */
export type HerdrHostId = string;

export const listHerdrHosts = (): ReadonlyArray<HerdrHostDef> =>
  hostsWithCapability("herdr").map((host) => ({
    id: host.id,
    label: host.label,
  }));

/** @deprecated Use listHerdrHosts() — alias kept for gradual call-site migration. */
export const HERDR_HOSTS = {
  get current(): ReadonlyArray<HerdrHostDef> {
    return listHerdrHosts();
  },
};

export const isKnownHerdrHost = (id: string): boolean => {
  if (id.startsWith("-")) return false;
  const host = findHostById(id);
  return host !== undefined && host.capabilities.includes("herdr");
};

export class UnknownHerdrHostError extends Error {
  readonly code = "invalid" as const;
  constructor(hostId: string) {
    const known = listHerdrHosts()
      .map((host) => host.id)
      .join(" | ");
    super(
      `unknown herdr host: ${hostId}${known ? ` (known: ${known})` : ""}`,
    );
    this.name = "UnknownHerdrHostError";
  }
}
