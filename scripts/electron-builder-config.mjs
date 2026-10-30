import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).build;
if (process.env.JUNTO_MACHINE_RELEASE_BUILD === "1") {
  if (process.env.JUNTO_PREVIEW_BUILD === "1" || process.env.JUNTO_CI_SOURCE_PACKAGE === "1") throw new Error("Preview and source builds cannot use machine release archives");
  config.extraResources = config.extraResources.filter(resource => resource.to !== "machines");
}
// The native junto CLI (0.12, N1) rides dormant in the Mac app until N7;
// build-app.sh builds it for aarch64-apple-darwin before packaging.
if (process.platform === "darwin") {
  config.extraResources = [...config.extraResources, { from: "dist/native/aarch64-apple-darwin/junto", to: "bin/junto-native" }];
}
export default config;
