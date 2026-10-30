/**
 * How long the running app's main process takes to answer, sampled from a
 * seat. The main process owns every PTY, so its event-loop stalls are added to
 * every key typed into a terminal and to every echo. Read-only: one work
 * control socket connection, op ping every 50 ms, for the given seconds.
 *
 * usage (inside a seat, which has JUNTO_WORK_SOCKET and JUNTO_WORK_TOKEN):
 *   bun scripts/perf-main-loop-probe.ts [seconds=60]
 */
import { createConnection } from "node:net";
import { spread } from "./perf-trace-summary";

const seconds = Number(process.argv[2] ?? 60);
const socketPath = process.env.JUNTO_WORK_SOCKET;
const token = process.env.JUNTO_WORK_TOKEN;
if (!socketPath || !token) throw new Error("run inside a seat: JUNTO_WORK_SOCKET and JUNTO_WORK_TOKEN are unset");

const rtts: number[] = [];
const frame = `${JSON.stringify({ token, op: "ping" })}\n`;
const socket = createConnection(socketPath);
const end = Date.now() + seconds * 1000;
let sentAt = 0;
let buffered = "";
const send = (): void => {
  if (Date.now() >= end) {
    socket.end();
    return;
  }
  sentAt = performance.now();
  socket.write(frame);
};
socket.on("connect", send);
socket.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  while (buffered.includes("\n")) {
    const line = buffered.slice(0, buffered.indexOf("\n"));
    buffered = buffered.slice(buffered.indexOf("\n") + 1);
    if (!line.includes('"pong"')) throw new Error(`unexpected reply: ${line.slice(0, 200)}`);
    rtts.push(performance.now() - sentAt);
    setTimeout(send, 50);
  }
});
socket.on("close", () => {
  console.log(JSON.stringify({
    seconds,
    rttMs: spread(rtts),
    over16_7: rtts.filter((r) => r > 16.7).length,
    over50: rtts.filter((r) => r > 50).length,
    over100: rtts.filter((r) => r > 100).length,
    stalledMsPerS: Math.round((rtts.filter((r) => r > 8.3).reduce((a, b) => a + b, 0) / seconds) * 10) / 10,
  }));
});
