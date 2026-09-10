/**
 * Expected macOS release identity is supplied by the build owner, never by
 * the candidate artifact or the runtime environment. Source builds may omit
 * it and run normally; admitting an official update or Remote package then
 * fails closed until an explicit signing policy is compiled into the app.
 */
export type MacSigningPolicy = {
  readonly teamIdentifier: string;
  readonly signingAuthority: string;
  readonly developerIdRequirement: string;
};

export const parseMacSigningPolicy = (
  teamIdentifier: string | undefined,
  signingAuthority: string | undefined,
): MacSigningPolicy => {
  if (
    teamIdentifier === undefined ||
    !/^[A-Z0-9]{10}$/u.test(teamIdentifier) ||
    signingAuthority === undefined ||
    !signingAuthority.startsWith("Developer ID Application: ") ||
    !signingAuthority.endsWith(` (${teamIdentifier})`) ||
    /[\r\n\0]/u.test(signingAuthority)
  ) {
    throw new Error("macOS release trust is not configured: rebuild with an explicit Developer ID signing identity and matching team");
  }
  return Object.freeze({
    teamIdentifier,
    signingAuthority,
    developerIdRequirement:
      `=anchor apple generic and identifier "skastr0.vellumcommand" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamIdentifier}"`,
  });
};

export const compiledMacSigningPolicy = (): MacSigningPolicy =>
  parseMacSigningPolicy(
    typeof __VELLUM_COMMAND_MAC_TEAM_ID__ === "string"
      ? __VELLUM_COMMAND_MAC_TEAM_ID__
      : undefined,
    typeof __VELLUM_COMMAND_MAC_SIGNING_IDENTITY__ === "string"
      ? __VELLUM_COMMAND_MAC_SIGNING_IDENTITY__
      : undefined,
  );
