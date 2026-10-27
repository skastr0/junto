/**
 * A preload entry that reaches what a sandboxed preload cannot run, for
 * tests/preload-bundle.test.ts. Never imported by the app.
 */
import { readFileSync } from "node:fs";
import { Schema } from "effect";

export const reached = [Schema.String, readFileSync];
