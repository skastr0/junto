#!/usr/bin/env bun
/** Independently distributed Linux desktop first-install bootstrap. */
import { runLinuxDesktopBootstrap } from "../src/main/junto/update/linux-first-install";

if (import.meta.main) {
  await runLinuxDesktopBootstrap(process.argv.slice(2));
}
