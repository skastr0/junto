import { fileURLToPath } from "node:url";
import path from "node:path";

// Release inputs are explicit and independent of the certificate being checked.
// Public source builds do not load this configuration unless signing is requested.
export const resolveMacSigningConfig = (environment = process.env) => {
  const teamIdentifier = environment.JUNTO_MAC_TEAM_ID ?? "";
  const signingIdentity = environment.JUNTO_MAC_SIGNING_IDENTITY ?? "";
  if (!/^[A-Z0-9]{10}$/u.test(teamIdentifier)) {
    throw new Error("JUNTO_MAC_TEAM_ID must be an explicit 10-character Apple team identifier");
  }
  if (
    !signingIdentity.startsWith("Developer ID Application: ") ||
    !signingIdentity.endsWith(` (${teamIdentifier})`) ||
    /[\r\n\0]/u.test(signingIdentity)
  ) {
    throw new Error("JUNTO_MAC_SIGNING_IDENTITY must be the full Developer ID Application identity for JUNTO_MAC_TEAM_ID");
  }
  return {
    teamIdentifier,
    signingIdentity,
    builderIdentity: signingIdentity.slice("Developer ID Application: ".length),
  };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = resolveMacSigningConfig();
    if (process.argv.length !== 3 || !["--check", "--builder-identity"].includes(process.argv[2])) {
      throw new Error("usage: bun scripts/mac-signing-config.mjs --check|--builder-identity");
    }
    if (process.argv[2] === "--builder-identity") process.stdout.write(config.builderIdentity);
  } catch (error) {
    console.error(`junto: ${error.message}`);
    process.exitCode = 1;
  }
}
