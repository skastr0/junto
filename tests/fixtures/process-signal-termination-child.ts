import type * as SignalTerminationModule from "../../src/main/junto/process-signal-termination";

const signalTerminationModulePath =
  "../../src/main/junto/process-signal-termination" + ".ts";
const { installProcessSignalTermination } = (await import(
  signalTerminationModulePath
)) as typeof SignalTerminationModule;

const mode = process.argv[2] === "fallback" ? "fallback" : "normal";
const keepAlive = setInterval(() => undefined, 1_000);

installProcessSignalTermination({
  app: {
    quit: () => {
      process.stdout.write("quit\n");
      if (mode === "fallback") return;
      setTimeout(() => {
        process.exit(0);
      }, 40);
    },
    exit: (exitCode = 0) => {
      process.stdout.write(`exit:${exitCode}\n`);
      process.exit(exitCode);
    },
  },
  cleanup: (signal) => {
    // Match packaged quit: adapter/Chromium teardown removes the final
    // Node-referenced handle before Electron's native loop has necessarily
    // completed. The mandatory app.exit fallback must remain runnable.
    clearInterval(keepAlive);
    process.stdout.write(`cleanup:${signal}\n`);
  },
  exitGraceMs: 80,
});

process.stdout.write("ready\n");
