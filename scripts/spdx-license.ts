import parseSpdxExpression from "spdx-expression-parse";

/**
 * Accept only current SPDX License List identifiers and exceptions.
 * Custom LicenseRef/DocumentRef values need a separate text-evidence and
 * human-rights policy, so Linux release v1 fails them closed.
 */
export const isRecognizedSpdxExpression = (candidate: string): boolean => {
  if (/(?:DocumentRef-|LicenseRef-)/u.test(candidate)) return false;
  try {
    parseSpdxExpression(candidate);
    return true;
  } catch {
    return false;
  }
};
