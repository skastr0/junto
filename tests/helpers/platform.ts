import { it } from "vitest";

/** Test declaration for cases that require the Linux host implementation. */
export const itOnLinux = it.skipIf(process.platform !== "linux");
