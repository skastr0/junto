/** CI may inspect an unsigned desktop package without native delivery builders. */
export const isCiSourcePackage = (environment: NodeJS.ProcessEnv = process.env): boolean => {
  if (environment.JUNTO_CI_SOURCE_PACKAGE !== "1") return false;
  if (environment.CI !== "true") throw new Error("CI source packaging requires CI=true");
  return true;
};
