# N0: native CLI baseline (task #515)

Installed CLI v0.11.0, app 0.11.0, MacBook, 2026-10-29.

- `bench.py N OUT` times each `junto` call against a direct socket call of the
  same op, interleaved in one window. Start-up = CLI wall time minus the socket
  time (connect plus full response). It waits for one-minute load under 40
  before each call; `run-loaded-2026-10-29.json` came from the same script with
  the wait removed, at load 370 to 490, 12 runs per call.
- `maillat.py` reads mail send-to-typed latency from the work database
  (message.append time to the PTY delivery receipt), read-only.
- `freq.py DIR...` counts `junto` subcommands in agent transcripts.
- `sample-leaves.py SAMPLE THREAD` sums self samples per frame for one thread
  of a macOS `sample` file.

## Results so far

| Call | CLI p50 ms | Server p50 ms | Start-up ms |
|---|---|---|---|
| `--version` | 519 | none | 519 |
| `ping` | 2048 | 9 | 2039 |
| `signal list` | 1028 | 6 | 1021 |
| `capabilities` | 1014 | 179 | 836 |
| `onboard` | 2261 | 607 | 1654 |
| `since` | 4510 | 539 | 3971 |
| `msg list` (996 KB) | 6602 | 3809 | 2793 |
| `/usr/bin/true` floor | 52 | none | 52 |

Loaded (370 to 490), so the absolutes are inflated; the idle table replaces it.

Mail, 7 days, 6,247 delivered: send to typed p50 2.17 s, p90 2.78 s. 2.0 s is
the batching wait (`MAIL_BATCHING`, `src/main/junto/work/message-delivery.ts`).
Prompts skip it: p50 0.18 s.

Most called, 7 days, 8,920 calls: msg reply 39.7%, msg send 28.2%, msg list
4.4%, onboard 3.9%, feedback 3.7%, msg read 2.9%.
