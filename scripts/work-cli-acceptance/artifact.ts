/**
 * junto artifact. Owner: pty-contract. Starts with the original
 * work-cli-acceptance.ts artifact create check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyOf, casesFor, type AcceptanceArea } from "./area";

const { check } = casesFor("artifact");

export const artifactArea: AcceptanceArea = {
  name: "artifact",
  owner: "pty-contract",
  run: async ({ cli, log, nodes, outside }) => {
    const artifactPath = join(outside, "report.txt");
    writeFileSync(artifactPath, "acceptance artifact body\n");
    const art = await cli(["artifact", "create", "report", "--type", "document", "--node", nodes.artifacts, "--markdown", readFileSync(artifactPath, "utf8")]);
    log("artifact create", art.stdout || art.stderr);
    const body = bodyOf(art);
    return [check("create", body?.ok === true && body.data?.outcome === "succeeded", art)];
  },
};
