import json, os, re, sys, glob, time, collections
cut = time.time() - 7*86400
pat = re.compile(r'(?:^|[;&|(\s`$])junto\s+((?:--?[\w-]+\s+)*)([a-z][\w-]*)(?:\s+([a-z][\w-]*))?')
TWO = {"msg","task","signal","artifact","seat","content","schema","examples","docs","machine","link","authority","canvas","node","region","note","file","automation","browser","git"}
cnt = collections.Counter(); files = 0; calls = 0
def scan_cmd(cmd):
    global calls
    for m in pat.finditer(cmd):
        a, b = m.group(2), m.group(3)
        key = f"{a} {b}" if a in TWO and b else a
        cnt[key] += 1; calls += 1
roots = sys.argv[1:]
for root in roots:
    for f in glob.glob(os.path.join(root, "**/*.jsonl"), recursive=True):
        if os.path.getmtime(f) < cut: continue
        files += 1
        for line in open(f, errors="ignore"):
            if '"junto ' not in line and 'junto ' not in line: continue
            try: d = json.loads(line)
            except: continue
            # claude: message.content[].type==tool_use name Bash input.command
            msg = d.get("message") if isinstance(d.get("message"), dict) else None
            if msg and isinstance(msg.get("content"), list):
                for c in msg["content"]:
                    if isinstance(c, dict) and c.get("type") == "tool_use" and isinstance(c.get("input"), dict):
                        cmd = c["input"].get("command")
                        if isinstance(cmd, str): scan_cmd(cmd)
            # codex: payload.type function_call arguments json with cmd
            p = d.get("payload")
            if isinstance(p, dict) and p.get("type") in ("function_call","custom_tool_call","local_shell_call"):
                args = p.get("arguments") or p.get("input") or ""
                if isinstance(args, str): scan_cmd(args)
print("files", files, "calls", calls)
for k, v in cnt.most_common(30): print(f"{v:7d} {100*v/calls:5.1f}% {k}")
