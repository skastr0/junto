import type * as SignalTerminationModule from "../../src/main/vellum/process-signal-termination";

const signalTerminationModulePath =
  "../../src/main/vellum/process-signal-termination" + ".ts";
const { installProcessSignalTermination } = (await import(
  signalTerminationModulePath
)) as typeof SignalTerminationModule;

const mode = process.argv[2] === "fallback" ? "fallback" : "normal";

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
    process.stdout.write(`cleanup:${signal}\n`);
  },
  exitGraceMs: 80,
});

process.stdout.write("ready\n");
setInterval(() => undefined, 1_000);
