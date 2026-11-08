/**
 * The CLI's JSON envelope from either stream: a success prints on stdout, a
 * failure on stderr. Owner: pty-contract.
 */
import type { WorkCliCommandResult } from "../work-cli-acceptance";

/** The last line of stdout, else of stderr, that parses as JSON; undefined when none does. */
export const envelopeOf = (result: WorkCliCommandResult): any => {
  for (const stream of [result.stdout, result.stderr]) {
    const lines = stream.trim().split("\n").reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // not this line
      }
    }
  }
  return undefined;
};
