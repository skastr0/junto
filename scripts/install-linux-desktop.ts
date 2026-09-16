#!/usr/bin/env bun
/** Source-checkout entry for independently trusted Linux desktop first install. */
import { runLinuxDesktopBootstrap } from "../src/main/junto/update/linux-first-install";

if (import.meta.main) {
  await runLinuxDesktopBootstrap(process.argv.slice(2));
}
