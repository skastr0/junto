declare const __JUNTO_BUILD_ID__: string | undefined;

/** Both entries receive the same fingerprint from the package builder. */
export const runningBuildIdentity = (): string => {
  if (typeof __JUNTO_BUILD_ID__ !== "string" || !/^[0-9a-f]{64}$/.test(__JUNTO_BUILD_ID__)) {
    throw new Error("Junto was built without a valid build identity");
  }
  return __JUNTO_BUILD_ID__;
};
