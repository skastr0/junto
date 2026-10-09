import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).build;
if (process.env.JUNTO_MACHINE_RELEASE_BUILD === "1") {
  if (process.env.JUNTO_PREVIEW_BUILD === "1" || process.env.JUNTO_CI_SOURCE_PACKAGE === "1") throw new Error("Preview and source builds cannot use machine release archives");
  config.extraResources = config.extraResources.filter(resource => resource.to !== "machines");
}
export default config;
