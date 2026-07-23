import { Effect } from "effect";
import type { Settings } from "@shared/settings";
import type { StationRole } from "@shared/station";
import { AppRuntime } from "../../runtime";
import { findHostById } from "../hosts/snapshot";
import {
  SettingsService,
  type SettingsServiceApi,
} from "../settings/service";
import type { BrowserHostCapabilityAuthority } from "./host-capability";

export interface BrowserHostCapabilityAuthorityLease {
  readonly authority: BrowserHostCapabilityAuthority;
  readonly close: () => void;
}

const stationIdentity = (
  settings: Settings,
): { readonly hostId: string; readonly role: StationRole } | undefined =>
  settings.station.role === ""
    ? undefined
    : {
        hostId: settings.station.hostId,
        role: settings.station.role,
      };

/**
 * Hydrates station identity before browser composition can activate, then
 * follows the same SettingsService transaction synchronously. Settings writes
 * publish only after their atomic rename, so browser admission observes either
 * the complete old identity or the complete new one—never a mixed tuple.
 */
export const prepareBrowserHostCapabilityAuthority = async (
  settings: Pick<SettingsServiceApi, "get" | "subscribe">,
  findHost: BrowserHostCapabilityAuthority["findHost"] = findHostById,
): Promise<BrowserHostCapabilityAuthorityLease> => {
  let current = stationIdentity(await Effect.runPromise(settings.get));
  let closed = false;
  const unsubscribe = settings.subscribe((next) => {
    current = stationIdentity(next);
  });
  return Object.freeze({
    authority: Object.freeze({
      findHost,
      station: () => current,
    }),
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  });
};

/** Production barrier used by browser composition before adapter creation. */
export const prepareDefaultBrowserHostCapabilityAuthority =
  async (): Promise<BrowserHostCapabilityAuthorityLease> => {
    const settings = await AppRuntime.runPromise(
      Effect.map(SettingsService, (service) => service),
    );
    return prepareBrowserHostCapabilityAuthority(settings);
  };
