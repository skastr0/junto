/**
 * The harness domain: Junto's vocabulary for what a seat is doing and why it
 * stopped. Features build on it; harnesses feed it through channels at
 * whatever fidelity each allows. Design: `docs/harness-domain.md`.
 */
export * from "./signal";
export * from "./status";
export * from "./need";
export * from "./capability";
export * from "./command";
export * from "./params";
export { BindingId } from "../terminal-session-domain";
