/**
 * Every group main serves to a window on its link. Main answers them with one
 * server per window, so a group here without a handler fails main's compile,
 * and a client of a group missing here fails the window's (`windowClient`).
 */
import { CompanionWindowRpcs } from "./companion";
import { ContentWindowRpcs } from "./content";
import { DemoWindowRpcs } from "./demo";
import { GitWindowRpcs } from "./git";
import { NotificationsWindowRpcs } from "./notifications";
import { ObservabilityWindowRpcs } from "./observability";
import { ReferencesWindowRpcs } from "./references";
import { SeatCacheDueWindowRpcs } from "./seat-cache-due";
import { ShellEnvironmentWindowRpcs } from "./shell-environment";
import { SignalsWindowRpcs } from "./signals";
import { UpdateWindowRpcs } from "./update";

export const WindowRpcs = UpdateWindowRpcs.merge(ReferencesWindowRpcs, SeatCacheDueWindowRpcs, ShellEnvironmentWindowRpcs, ObservabilityWindowRpcs, GitWindowRpcs, CompanionWindowRpcs, SignalsWindowRpcs, ContentWindowRpcs, NotificationsWindowRpcs, DemoWindowRpcs);
