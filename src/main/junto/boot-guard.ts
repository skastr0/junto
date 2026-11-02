/**
 * The boot half of `@shared/e2e-sandbox`: print the reason and exit nonzero,
 * before the process opens the database, a log, a control socket or a window.
 *
 * Two rules live behind it. The first holds for every launch: a Junto process
 * that inherited a seat's identity refuses to start, because only an app
 * started from inside a seat carries one, and that app would present the
 * seat's credential and report to the live work socket. The second holds in an
 * E2E run: the paths stay out of the operator's `~/.junto`, and a seat runs
 * only a harness inside its sandbox.
 *
 * Electron main and the core both call it, because either can be started with
 * an environment the other never saw.
 */
import { userInfo } from "node:os";
import { bootRefusal, type E2eSandboxRefusal } from "@shared/e2e-sandbox";

export const BOOT_REFUSAL_PREFIX = "[junto] refused to start:";

/** The account home, from the password entry, never from `$HOME`. */
export const realAccountHome = (): string => userInfo().homedir;

/**
 * Refuses a launch the tripwire covers. Returns the refusal it printed, so a
 * caller (or a test) can see what happened; otherwise it returns `undefined`
 * and does nothing.
 */
export const enforceBootRefusal = (input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly realHome?: string;
  readonly userData?: string | undefined;
  readonly juntoHome?: string | undefined;
} = {}): E2eSandboxRefusal | undefined => {
  const refusal = bootRefusal({
    env: input.env ?? process.env,
    realHome: input.realHome ?? realAccountHome(),
    ...(input.userData === undefined ? {} : { userData: input.userData }),
    ...(input.juntoHome === undefined ? {} : { juntoHome: input.juntoHome }),
  });
  if (refusal === undefined) return undefined;
  console.error(`${BOOT_REFUSAL_PREFIX} ${refusal.reason}`);
  process.exit(1);
};
