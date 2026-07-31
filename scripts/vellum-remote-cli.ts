#!/usr/bin/env bun
/**
 * Packaged Linux Remote entry (`resources/bin/vellum-remote`).
 *
 * Sealed argv surface:
 *   --install-user-service   write generation-pinned unit + station helper
 *   --vellum-state-preflight  read-only state admission (no runtime planes)
 *
 * Default (no args): reserved for the displayless Remote station runtime.
 * The work-plane entry is not yet wired into this binary; fail closed.
 */
import {
  INSTALL_USER_SERVICE_SWITCH,
  installUserlandLinuxRemoteService,
} from "../src/main/vellum/supervision/install-user-service";
import {
  REMOTE_STATE_PREFLIGHT_SWITCH,
  runRemoteStatePreflight,
} from "../src/main/vellum/supervision/remote-state-preflight";

const usage = (): never => {
  process.stderr.write(
    "vellum-remote: usage: vellum-remote [--install-user-service | --vellum-state-preflight]\n",
  );
  process.exit(64);
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === INSTALL_USER_SERVICE_SWITCH) {
    try {
      const receipt = installUserlandLinuxRemoteService(process.execPath);
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          switch: INSTALL_USER_SERVICE_SWITCH,
          releaseDirectory: receipt.releaseDirectory,
          unitPath: receipt.unitPath,
          helperPath: receipt.helperPath,
        })}\n`,
      );
      return;
    } catch (error) {
      process.stderr.write(
        `vellum-remote: install-user-service failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exit(70);
    }
  }

  if (args.length === 1 && args[0] === REMOTE_STATE_PREFLIGHT_SWITCH) {
    try {
      const receipt = runRemoteStatePreflight(process.execPath);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      return;
    } catch (error) {
      process.stderr.write(
        `vellum-remote: state-preflight failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exit(70);
    }
  }

  if (args.length === 0) {
    process.stderr.write(
      "vellum-remote: station runtime plane is not yet available in this binary\n",
    );
    process.exit(69);
  }

  usage();
};

main();
