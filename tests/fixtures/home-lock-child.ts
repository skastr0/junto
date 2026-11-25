/**
 * A core's home lock in its own process, for tests/home-lock.test.ts.
 * `hold <home>`: take it, say TAKEN or REFUSED <reason>, and hold until killed.
 * `orphan <home>`: take it, start a long-lived child as a seat would, say its
 * pid, and die by SIGKILL, so the child outlives the holder.
 */
import { spawn } from "node:child_process";
import { acquireHomeLock, HomeLockRefused } from "../../src/node/home-lock";

const [mode, home] = process.argv.slice(2) as ["hold" | "orphan", string];
try {
  await acquireHomeLock(home);
} catch (error) {
  console.log(`REFUSED ${error instanceof HomeLockRefused ? error.reason : String(error)}`);
  process.exit(0);
}
if (mode === "orphan") {
  const seat = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  seat.unref();
  console.log(`SEAT ${seat.pid}`);
  process.kill(process.pid, "SIGKILL");
}
console.log("TAKEN");
setInterval(() => undefined, 1 << 30);
