import sqlite3, hashlib, json, os, datetime, statistics
db = sqlite3.connect("file:" + os.path.expanduser("~/.junto/state/junto.db") + "?mode=ro", uri=True)
def ts(s): return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
since = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
app = dict(db.execute("select item_id, origin_at from work_events where operation='message.append' and received_at >= ?", (since,)))
rec = dict(db.execute("select delivery_id, accepted_at from work_delivery_receipts where delivered_item_kind='message' and accepted_at >= ?", (since,)))
rows = db.execute("select canvas_name,node_id,message_id,metadata_json from work_messages where role='user'").fetchall()
lat = []; kinds = {}
for c, n, m, md in rows:
    if m not in app: continue
    did = "delivery_" + hashlib.sha256(json.dumps(["junto/mailbox-message-delivery/v1", c, n, m], separators=(",",":")).encode()).hexdigest()
    if did not in rec: continue
    d = ts(rec[did]) - ts(app[m])
    k = (json.loads(md or "{}") or {}).get("mailKind", "?")
    lat.append(d); kinds.setdefault(k, []).append(d)
lat.sort()
def q(a, p): return a[min(len(a)-1, int(p*len(a)))]
print("delivered mails, 7 days:", len(lat), "of appended", len(app))
for p in (.1,.25,.5,.75,.9,.99): print(f"  p{int(p*100)}: {q(lat,p):.2f} s")
b = [(0,1),(1,2),(2,3),(3,5),(5,12),(12,60),(60,600),(600,1e9)]
for lo, hi in b: print(f"  [{lo},{hi}) s: {sum(lo<=x<hi for x in lat)}")
live = [x for x in lat if x < 12]
print("typed within 12 s (seat live, batch window):", len(live), "p50 %.2f p90 %.2f" % (q(live,.5), q(live,.9)))
for k, v in sorted(kinds.items(), key=lambda kv: -len(kv[1]))[:6]:
    v.sort(); print(" kind", k, len(v), "p50 %.2f" % q(v,.5))
