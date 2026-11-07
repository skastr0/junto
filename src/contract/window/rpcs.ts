/**
 * Every group main serves to a window on its link. Main answers them with one
 * server per window, so a group here without a handler fails main's compile,
 * and a client of a group missing here fails the window's (`windowClient`).
 */
import { GitWindowRpcs } from "./git";
import { ReferencesWindowRpcs } from "./references";
import { ShellEnvironmentWindowRpcs } from "./shell-environment";
import { UpdateWindowRpcs } from "./update";

export const WindowRpcs = UpdateWindowRpcs.merge(ReferencesWindowRpcs, ShellEnvironmentWindowRpcs, GitWindowRpcs);
