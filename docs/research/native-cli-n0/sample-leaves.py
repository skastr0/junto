import re, sys, collections
lines = open(sys.argv[1]).read().splitlines()
start = next(i for i,l in enumerate(lines) if "Thread_" in l and sys.argv[2] in l)
end = next(i for i in range(start+1, len(lines)) if re.match(r"^\s{4}\d+ Thread_", lines[i]) or not lines[i].strip())
rx = re.compile(r"^([\s+!:|]*)(\d+) (.*)$")
rows = []
for l in lines[start:end]:
    m = rx.match(l)
    if m: rows.append((len(m.group(1)), int(m.group(2)), m.group(3)))
leaf = collections.Counter(); total = rows[0][1]
for i,(d,c,f) in enumerate(rows):
    kids = 0; j = i+1
    while j < len(rows) and rows[j][0] > d:
        if rows[j][0] == rows[i+1][0] if i+1 < len(rows) else False: kids += rows[j][1]
        j += 1
    self_ = c - kids if j > i+1 else c
    if self_ > 0: leaf[re.sub(r"\s+\[0x[0-9a-f]+\].*|\s+\+ \d+.*", "", f)[:110]] += self_
print("thread samples", total)
for f,c in leaf.most_common(25): print(f"{c:6d} {100*c/total:5.1f}% {f}")
