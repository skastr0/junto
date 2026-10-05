# Recordings outside the corpus

Real PTY byte streams that a single test needs and that are not part of the
capture corpus in `../corpus` (the Jev checkpoint manifest is rebuilt from
that folder, so a file added there changes it).

Same line format as the corpus: one JSON per line, `{"t": ms, "b64": base64}`.

| file | harness | what it shows | how it was recorded |
|---|---|---|---|
| `claude-startup-trust.jsonl` | Claude Code 2.1.289, 120x32 | the folder-trust dialog, default option "No, exit" | launched in an empty folder it had never seen, no input sent, killed after 7s; the folder path is replaced by `<CWD>` |
