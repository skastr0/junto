/**
 * Remote Stations are still an unreleased product surface.
 *
 * While this state remains unreleased, contract shapes may evolve in place but
 * every independently named Remote Station contract stays at version 1. The
 * first compatibility bump is release work and requires changing this exact
 * state deliberately before any guarded version can move.
 */
export type RemoteStationsReleaseState =
  | "REMOTE STATIONS ARE NOT RELEASED"
  | "REMOTE STATIONS ARE RELEASED";

export const REMOTE_STATIONS_RELEASED =
  "REMOTE STATIONS ARE RELEASED" as const;

export const REMOTE_STATIONS_RELEASE_STATE =
  "REMOTE STATIONS ARE NOT RELEASED" as const satisfies RemoteStationsReleaseState;

type RemoteStationContractVersion =
  typeof REMOTE_STATIONS_RELEASE_STATE extends typeof REMOTE_STATIONS_RELEASED
    ? number
    : 1;

const remoteStationsAreReleased = (
  state: RemoteStationsReleaseState,
): boolean => state === REMOTE_STATIONS_RELEASED;

/**
 * Fail during module initialization if an unreleased Remote Station contract
 * is assigned any version other than 1.
 */
export const remoteStationContractVersion = <
  const Version extends RemoteStationContractVersion,
>(
  contract: string,
  version: Version,
): Version => {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`${contract} version must be a positive safe integer`);
  }
  if (
    !remoteStationsAreReleased(REMOTE_STATIONS_RELEASE_STATE) &&
    version !== 1
  ) {
    throw new TypeError(
      `${contract} must remain at version 1 until REMOTE_STATIONS_RELEASE_STATE is "${REMOTE_STATIONS_RELEASED}"`,
    );
  }
  return version;
};
