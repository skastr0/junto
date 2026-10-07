# Live app startup investigation

Captured 7 October 2026, 07:16–07:20 UTC, against the installed Junto 0.5.0 process. The operator reports that stutter was strongest while Claude seats were starting. This capture began after those starts; it does not measure the offending startup window.

**Finding:** Claude sessions are separate processes. The capture does not show sustained Claude CPU saturation or swapping. Normal seat startup nevertheless performs synchronous work in Electron main, including two separate process observations. Startup and renderer work deserve a timed reproduction before attributing the reported stutter to either.

## Running build and method

The main PID was 40070, renderer 40088, and GPU helper 40077. The helper's native sample contains `GpuWatchdog`, `VizCompositorThread`, and Metal command queues; its CPU use is not a measurement of GPU occupancy.

The installed `app.asar` was read without changing it. Its modification time precedes the sampled app's launch. The extracted `out/main/index.js` SHA-256 is `95d83a387f0ce1811ab21af940dd0dafaeffea9f7ef085734ce1d7466e4dfbd8`. Relevant compiled-code excerpts are retained in the [evidence](research/live-app-startup/observations.json), so the source observations below were also checked against this installed build.

Measurements used process names and numeric statistics, never argv or credential values. There was no seat stop, new seat launch, app restart, production database access, or animation change. The only generated app traffic was one 24-call read-only packaged-CLI ping burst.

## Measured current workload

Eleven process snapshots span 20.66 seconds, at approximately two-second intervals. Interval CPU comes from differences in cumulative process CPU time, rather than the smoothed instantaneous `%CPU` field.

| Group | Processes | Average CPU, one core = 100% | End-window resident-set sum |
|---|---:|---:|---:|
| Junto main | 1 | 6.34% | 443 MiB |
| Junto renderer | 1 | 11.71% | 973 MiB |
| Junto helpers | 3 | 6.34% | 365 MiB |
| Claude descendants | 9 | 14.28% combined | 4,884 MiB |

The machine has ten logical CPUs and 64 GiB RAM. Swap usage was zero; subsequent `top` interval readings showed 47–71% total CPU idle. There was substantial system-wide memory compression, so zero swapping alone is not proof that memory has no cost. Resident-set sums also count shared mappings and are not unique physical-memory totals.

The first instantaneous snapshot was busier: main 13.1%, renderer 19.2%, GPU helper 38.5%, and WindowServer 75.7%. These are different measurements from the interval table. WindowServer serves the whole desktop; another Electron app from this repository and other applications were active. This is a natural workload, not an exclusive benchmark.

Five-second native samples at two-millisecond intervals captured main, renderer, and GPU helper concurrently. Main's dominant AppKit event-wait leaf accounted for 1,889 of 2,095 main-thread samples, about 90%. This sample does not reproduce the earlier synchronous identity-spawn blockage. Native Electron symbols have large offsets and do not reliably name the JavaScript work; exported V8/crypto symbol labels must not be interpreted as application function attribution.

## Live CLI check

All 24 packaged `junto ping` calls succeeded against the installed 0.5.0 app. Batch wall time was **469.74 ms**, individual median **261.93 ms**, p95 **461.53 ms**, and maximum **466.56 ms**. These times include CLI startup and concurrent process scheduling. They are not server-only processing times.

A simultaneous five-second main sample again predominantly shows event waiting: the largest AppKit wait leaf contains 1,948 of 2,102 samples, about 93%. This is evidence about this particular ping burst, not all message operations or visual responsiveness. No renderer frame-gap or input-latency measurement was obtained.

## Startup work still on main

The current source and installed bundle agree on the normal local-seat path:

1. [Seat occupation](../src/main/junto/term/seat-process.ts) calls launch finalization and `host.createAgentSeat` in an `Effect.try` callback. A callback inside Effect still runs synchronous code on its calling thread.
2. [Native terminal spawn](../src/main/junto/app-process-plane.ts) invokes `nodePty.spawn` directly. The installed node-pty implementation calls its native `pty.fork` synchronously. The launched Claude runtime subsequently runs in its own process; Junto does not execute all Claude runtimes inside Electron main.
3. Terminal registration calls `admitChildProcess`, which captures a process epoch through [process-epoch.ts](../src/main/junto/process-epoch.ts). Its default single-PID reader uses synchronous `ps`.
4. [Local host registration](../src/main/junto/term/local-host.ts) then calls `bindPtyProcessIdentity`, whose default [process-identity.ts](../src/main/junto/process-identity.ts) map separately reads a start key with synchronous `ps`. This remains a startup cost even though ordinary CLI admission now uses the injected generation credential.
5. Named-session resume may also synchronously inspect harness files through [session-existence.ts](../src/main/junto/term/session-existence.ts). Main creates a headless terminal observer and consumes each child's output, so simultaneous welcome-screen output and state changes can add main and renderer work after the fork.

An external Bun probe ran the two actual source observation helpers against one already-live Claude PID, twenty times. All observations succeeded. The median combined time was **7.00 ms**, maximum **12.45 ms**. Ten serial pairs would therefore cost about **70 ms at that median**, excluding fork, resume checks, output parsing, durable updates, and rendering. This is an extrapolation from an external helper probe, not a measured ten-seat Electron stall, and actual launch scheduling may allow event-loop turns between seats.

The observer already batches dense output and has separate watched/unwatched scrollback tiers. Its existence alone does not establish a performance defect; the capture did not measure output-byte rates, parser time, or update fan-out.

## Next measurement and improvement candidates

Capture an actual operator-triggered startup batch with a common timeline for launch preparation, native spawn, both process observations, first PTY output, observer parsing/publication, renderer updates, and presented frame gaps. Compare one launch with a batch, then repeat the batch with animation paused while preserving seat work. The current main process exposes no TCP debugging listener, so this run obtained native samples rather than JavaScript/compositor tracing.

If startup attribution confirms the synchronous observations, make those observations asynchronous and consider sharing one validated epoch result between process-ownership and registration consumers. Preserve admission order and exact-generation checks. Measure and yield between launch completions before introducing a process or worker boundary for heavier work. Existing Effect wrappers do not by themselves make synchronous native or filesystem calls non-blocking.

No architecture change or performance fix was made in this investigation. The measured CLI burst passes; the reported startup stutter remains unverified by a matching capture.

## Receipts and reproduction

[observations.json](research/live-app-startup/observations.json) contains numeric snapshots, raw CLI timings, helper timings, installed bundle excerpts/hash, trace metadata, and SHA-256 receipts. Full native samples and the collector remain in the temporary directory `/tmp/junto-live-profile.kGOJlp`; hashes are durable, those scratch files are not.

The process survey uses `ps -axo pid,ppid,pcpu,rss,time,comm` every two seconds, walking descendants of the confirmed app PID. CPU percentages are `100 × (ending CPU seconds − starting CPU seconds) / elapsed wall seconds`; processes not present at both endpoints are excluded from interval CPU totals. Native samples use `sample PID 5 2 -file PATH`. The CLI burst starts 24 `junto ping` children concurrently and validates every JSON response and exit code without persisting response bodies or environment values.

## Follow-up: discovery still blocks main

At 07:32 UTC, after the performance lead reported a slow discovery burst, an independent 24-call `junto capabilities` burst ran against the same live 0.5.0 process. Every call succeeded and identified this seat correctly. Total wall time was **2,410.91 ms**, median request time **1,581.42 ms**, p95 **2,395.68 ms**, maximum **2,400.08 ms**. Main and renderer were sampled concurrently for five seconds.

Main's first thread had 2,073 samples: 220 passed through `uv_fs_scandir` (10.6%), 149 through `uv_fs_stat` (7.2%), and 50 through `uv_fs_access` (2.4%). These are inclusive per-function counts across the entire five-second capture, including background work; they are not a timestamped attribution of every request. A small number of synchronous process-spawn frames were also present, without enough JavaScript attribution to name their caller or command. This follow-up does not claim that all main-process spawning is absent.

The installed bundle and current source agree on a concrete repeated synchronous path: `capabilities` calls `probeManagedHarnessInstalls`; that maps all harness templates through binary resolution; each binary resolution rebuilds `harnessSearchPath`; that calls `enumeratedToolDirs`, which expands version-manager roots using synchronous directory reads and stats, followed by executable access checks. The directory discovery repeats per harness and per request. [work/control.ts](../src/main/junto/work/control.ts), [templates/harness-install.ts](../src/main/junto/term/templates/harness-install.ts), and [adapters/exec.ts](../src/main/junto/adapters/exec.ts) contain the corresponding source. Installed-code excerpts and trace receipts are under `capabilitiesFollowup` in the evidence JSON.

**Updated verdict:** the ordinary generation-token identity replacement and ping qualification stand. The broader CLI performance problem is not fully resolved: discovery commands still execute repeated synchronous filesystem work on main. Ping alone was insufficient coverage for that broader claim. Renderer frame loss and simultaneous startup remain unmeasured. No implementation changes were made; the shared harness-install file was already being edited by another seat and was left untouched.
