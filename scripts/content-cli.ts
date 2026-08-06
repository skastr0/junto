#!/usr/bin/env bun
/**
 * Dev convenience shim. Packaged installs use `vellum-command content-transfer …` only.
 */
import { runContentTransfer } from "../src/cli/content-transfer";

await runContentTransfer(process.argv.slice(2));
