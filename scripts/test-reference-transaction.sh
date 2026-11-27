#!/usr/bin/env bash
# Proves scripts/git-hooks/reference-transaction in throwaway repos, in the
# layout the real repo uses: the hook installed as .git/hooks/reference-transaction,
# a stub that runs the tracked file for state "committed" only and ignores its
# status, with core.hooksPath unset. Run it on a VM
# (scripts/vm.sh run <id> 'bash scripts/test-reference-transaction.sh'), never on the MacBook.
# Prints one line per check: expected, seen. Exits 1 if any check differs.
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
HOOK=${1:-$HERE/git-hooks/reference-transaction}
[ -f "$HOOK" ] || { echo "no hook at $HOOK" >&2; exit 2; }
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/follow-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
fails=0
ms() { date +%s%N | cut -c1-13; }
expect() { # label expected seen
  if [ "$2" = "$3" ]; then printf 'ok    %-60s expected [%s] seen [%s]\n' "$1" "$2" "$3"
  else printf 'FAIL  %-60s expected [%s] seen [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi
}
mk() { # a repo with the hook installed as the real repo installs it
  d=$(mktemp -d "$ROOT/case.XXXXXX"); R=$d/repo
  git init -q "$R"; git -C "$R" symbolic-ref HEAD refs/heads/main
  (
    cd "$R" || exit 1
    mkdir -p scripts/git-hooks dir
    cp "$HOOK" scripts/git-hooks/reference-transaction; chmod +x scripts/git-hooks/reference-transaction
    for f in a b c d; do echo "$f v1" > $f.txt; done
    printf '#!/bin/sh\necho v1\n' > e.sh; chmod 755 e.sh
    echo "f v1" > dir/f.txt; echo "Foo v1" > Foo.txt
    git add -A; git commit -qm v1
    cat > .git/hooks/reference-transaction <<'STUB'
#!/bin/sh
f="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/git-hooks/reference-transaction"
case "$1" in
  prepared)
    all=""
    has_head=0
    has_main=0
    while IFS= read -r line; do
      all="${all}${line}
"
      case "$line" in
        *" HEAD") has_head=1 ;;
        *" refs/heads/main") has_main=1 ;;
      esac
    done
    [ "$has_head" = 1 ] || exit 0
    [ "$has_main" = 1 ] && exit 0
    [ -x "$f" ] || exit 0
    printf '%s' "$all" | "$f" prepared
    exit $?
    ;;
  committed)
    [ -x "$f" ] && "$f" "$@"
    exit 0
    ;;
esac
exit 0
STUB
    chmod +x .git/hooks/reference-transaction
  )
  OLD=$(git -C "$R" rev-parse HEAD)
}
wt_v2() { # a linked worktree commits v2: edits, a delete, an add, a nested file, an exec file
  git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
  (
    cd "$d/wt" || exit 1
    echo "a v2" > a.txt; echo "c v2" > c.txt; git rm -q b.txt; echo new > new.txt
    printf '#!/bin/sh\necho v2\n' > e.sh; echo "f v2" > dir/f.txt
    git add -A; git commit -qm v2
  )
  NEW=$(git -C "$d/wt" rev-parse HEAD)
}
land() { # land NEW over OLD from the worktree by update-ref; $@ is an env prefix
  local t0 t1
  t0=$(ms); (cd "$d/wt" && "$@" git update-ref refs/heads/main "$NEW" "$OLD"); UPRC=$?; t1=$(ms)
  ELAPSED=$((t1 - t0))
}
quiet() { # the follower is done: its lock is gone
  local i=0
  sleep 0.4
  while [ -e "$R/.git/junto-follow.lock" ] && [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
  sleep 0.2
  SETTLE=$((i * 100 + 600))
}
status() { git -C "$R" status --porcelain | tr '\n' '|'; }
log() { cat "$R/.git/junto-follow.log" 2>/dev/null | sed 's/^[^ ]* //'; }
nologfor() { log | grep -c "$1" | tr -d ' '; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

echo "== 1 a landing from a linked worktree, main checkout stale, two paths with real work"
mk
echo "c real work" > "$R/c.txt"; echo "d real work" > "$R/d.txt"
wt_v2; land env; quiet
expect "update-ref exit" 0 "$UPRC"
expect "the landing did not wait for the follower (ms under 500)" yes "$([ "$ELAPSED" -lt 500 ] && echo yes || echo "no: $ELAPSED")"
expect "main moved" "$NEW" "$(git -C "$R" rev-parse main)"
expect "a.txt follows main" "a v2" "$(cat "$R/a.txt")"
expect "a written file has mode 644 whatever the seat's umask" 644 "$(mode "$R/new.txt")"
expect "add: new.txt written" "new" "$(cat "$R/new.txt" 2>/dev/null)"
expect "delete: b.txt removed" "absent" "$([ -e "$R/b.txt" ] && echo present || echo absent)"
expect "nested dir/f.txt follows main" "f v2" "$(cat "$R/dir/f.txt")"
expect "e.sh content follows, mode 755 kept" "echo v2 755" "$(sed -n 2p "$R/e.sh") $(mode "$R/e.sh")"
expect "real work in c.txt untouched" "c real work" "$(cat "$R/c.txt")"
expect "real work in d.txt untouched (not in the landing)" "d real work" "$(cat "$R/d.txt")"
expect "git status: only the two real edits, index followed" " M c.txt| M d.txt|" "$(status)"
expect "log: one line, 5 restored, 1 kept (c.txt), index followed" "${OLD:0:9}..${NEW:0:9} restored 5, kept 1 [c.txt (own edit)], skipped-index no" "$(log)"
expect "the last followed commit is recorded" "$NEW" "$(cat "$R/.git/junto-follow.head")"
expect "nothing left in .git or the checkout" "" "$(find "$R/.git" -maxdepth 1 -name 'junto-follow.*' ! -name junto-follow.log ! -name junto-follow.head | tr '\n' ' ')$(cd "$R" && git status --porcelain --ignored | grep junto-follow)"

echo "== 2 a private-index landing from the main checkout"
mk
echo "a v2" > "$R/a.txt"; echo "b mine, not landed" > "$R/b.txt"
(
  cd "$R" || exit 1
  IDX=$(mktemp -u "$ROOT/idx.XXXXXX")
  GIT_INDEX_FILE=$IDX git read-tree "$OLD"; GIT_INDEX_FILE=$IDX git add -- a.txt
  TREE=$(GIT_INDEX_FILE=$IDX git write-tree)
  N=$(printf 'v2 a\n' | git commit-tree "$TREE" -p "$OLD")
  git update-ref refs/heads/main "$N" "$OLD"; echo "$N" > "$ROOT/new2"; rm -f "$IDX"
)
NEW=$(cat "$ROOT/new2"); quiet
expect "a.txt is clean after the landing (index followed)" " M b.txt|" "$(status)"
expect "b.txt untouched" "b mine, not landed" "$(cat "$R/b.txt")"
expect "log: 0 restored, 0 kept" "${OLD:0:9}..${NEW:0:9} restored 0, kept 0, skipped-index no" "$(log)"

echo "== 3 a path with real uncommitted work that the landing also changes"
mk
echo "c real work" > "$R/c.txt"
wt_v2; land env; quiet
expect "c.txt keeps the real work" "c real work" "$(cat "$R/c.txt")"
expect "c.txt named in the log as kept" yes "$(log | grep -q 'kept 1 \[c.txt (own edit)\]' && echo yes || echo no)"
expect "the landing's other files still followed" "a v2" "$(cat "$R/a.txt")"

echo "== 4 a held index.lock: the index is skipped, never waited for"
mk
: > "$R/.git/index.lock"
wt_v2; land env; quiet
rm -f "$R/.git/index.lock"
expect "update-ref exit" 0 "$UPRC"
expect "files still followed" "a v2" "$(cat "$R/a.txt")"
expect "log says the index was skipped for the lock" yes "$(log | grep -q 'skipped-index yes (index.lock held)' && echo yes || echo no)"
expect "the follower finished in well under the budget (ms under 3000)" yes "$([ "$SETTLE" -lt 3000 ] && echo yes || echo "no: $SETTLE")"

echo "== 5 a landing on a branch other than main"
mk
git -C "$R" branch other
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "a v2" > a.txt && git add -A && git commit -qm v2 )
NEW=$(git -C "$d/wt" rev-parse HEAD)
git -C "$R" update-ref refs/heads/other "$NEW" "$OLD"; rc=$?; quiet
expect "update-ref exit" 0 "$rc"
expect "checkout untouched" "a v1" "$(cat "$R/a.txt")"
expect "no log line, no head file" "" "$(log)$(cat "$R/.git/junto-follow.head" 2>/dev/null)"

echo "== 6 the checkout is not on main: no-op, one line"
mk
JUNTO_ALLOW_HEAD_SWITCH=1 git -C "$R" checkout -q -b side
wt_v2; land env; quiet
expect "checkout untouched" "a v1" "$(cat "$R/a.txt")"
expect "log names the branch" yes "$(log | grep -q 'skipped, the checkout is on side' && echo yes || echo no)"

echo "== 7 a follower that gives up (awk shimmed to sleep, budget 2 s), then a second landing"
mk
SHIM=$ROOT/shim; mkdir -p "$SHIM"
# git puts its own exec path ahead of PATH for a hook, so a git shim is bypassed; awk is not.
printf '#!/bin/sh\nsleep 8\nexec %s "$@"\n' "$(command -v awk)" > "$SHIM/awk"; chmod +x "$SHIM/awk"
wt_v2; land env JUNTO_FOLLOW_BUDGET=2 "PATH=$SHIM:$PATH"; quiet
expect "update-ref exit" 0 "$UPRC"
expect "main moved" "$NEW" "$(git -C "$R" rev-parse main)"
expect "the landing did not wait (ms under 500)" yes "$([ "$ELAPSED" -lt 500 ] && echo yes || echo "no: $ELAPSED")"
expect "log says it gave up" yes "$(log | grep -q 'gave up after 2 s' && echo yes || echo no)"
expect "a.txt not followed yet" "a v1" "$(cat "$R/a.txt")"
expect "no temp directory, marker or lock left" "" "$(find "$R/.git" -maxdepth 1 -name 'junto-follow.*' ! -name junto-follow.log ! -name junto-follow.head | tr '\n' ' ')"
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); NEW3=$(git -C "$d/wt" rev-parse HEAD)
( cd "$d/wt" && git update-ref refs/heads/main "$NEW3" "$NEW" ); quiet
expect "second landing: a.txt now follows main" "a v2" "$(cat "$R/a.txt")"
expect "second landing: g.txt written too" "g v3" "$(cat "$R/g.txt" 2>/dev/null)"
expect "git status clean: no staged revert" "" "$(status)"
expect "no false own edit in the log" 0 "$(nologfor 'own edit')"
expect "the last followed commit is the tip" "$NEW3" "$(cat "$R/.git/junto-follow.head")"

echo "== 8 the hook run outside any repo, and with garbage, exits 0"
( cd "$ROOT" && echo "x y refs/heads/main" | "$HOOK" committed ); expect "exit outside a repo" 0 $?
( cd "$ROOT" && echo "" | "$HOOK" prepared ); expect "exit on state prepared" 0 $?

echo "== 9 four hundred changed paths in one landing"
mk
( cd "$R" && mkdir -p bulk && for i in $(seq 1 400); do echo "v1 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk1 )
OLD=$(git -C "$R" rev-parse HEAD)
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && for i in $(seq 1 400); do echo "v2 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk2 )
NEW=$(git -C "$d/wt" rev-parse HEAD)
# a long budget: this case is about correctness; how long 400 paths take on a loaded VM is printed below
land env JUNTO_FOLLOW_BUDGET=60; quiet
expect "the landing did not wait (ms under 500)" yes "$([ "$ELAPSED" -lt 500 ] && echo yes || echo "no: $ELAPSED")"
expect "all 400 follow main" 400 "$(grep -l '^v2 ' "$R"/bulk/f*.txt | wc -l | tr -d ' ')"
expect "git status clean" "" "$(status)"
echo "      400 paths: the follower finished about $SETTLE ms after the landing"

echo "== 10 the stub cannot block a landing"
mk; wt_v2
rm -f "$R/scripts/git-hooks/reference-transaction"
land env
expect "tracked hook file missing: update-ref exit 0, main moved" "0 $NEW" "$UPRC $(git -C "$R" rev-parse main)"
mk; wt_v2
chmod -x "$R/scripts/git-hooks/reference-transaction"
land env
expect "tracked hook file not executable: exit 0, main moved" "0 $NEW" "$UPRC $(git -C "$R" rev-parse main)"
mk; wt_v2
printf '#!/usr/bin/env bash\nif then fi (\n' > "$R/scripts/git-hooks/reference-transaction"
land env
expect "tracked hook file with a syntax error: exit 0, main moved" "0 $NEW" "$UPRC $(git -C "$R" rev-parse main)"

echo "== 11 two landings a few milliseconds apart"
mk
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "a v2" > a.txt && git add -A && git commit -qm v2 )
V2=$(git -C "$d/wt" rev-parse HEAD)
( cd "$d/wt" && echo "a v3" > a.txt && echo "x v3" > x.txt && git add -A && git commit -qm v3 )
V3=$(git -C "$d/wt" rev-parse HEAD)
( cd "$d/wt" && git update-ref refs/heads/main "$V2" "$OLD" && git update-ref refs/heads/main "$V3" "$V2" ); quiet
expect "a.txt is at v3" "a v3" "$(cat "$R/a.txt")"
expect "x.txt written" "x v3" "$(cat "$R/x.txt" 2>/dev/null)"
expect "git status clean" "" "$(status)"
expect "no false own edit in the log" 0 "$(nologfor 'own edit')"
expect "the last followed commit is the tip" "$V3" "$(cat "$R/.git/junto-follow.head")"

echo "== 12 a rename that only changes case: the removal runs before the add"
mk
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && git mv Foo.txt foo.txt && git commit -qm rename )
NEW=$(git -C "$d/wt" rev-parse HEAD); land env; quiet
expect "foo.txt is there with its content" "Foo v1" "$(cat "$R/foo.txt" 2>/dev/null)"
expect "Foo.txt is gone" "foo.txt" "$(ls "$R" | grep -i '^foo.txt$')"
expect "git status clean" "" "$(status)"
echo "      (the disk here tells case apart; macOS APFS does not, and is not exercised)"

echo "== 13 a symlinked directory above an added path is never written through"
mk
mkdir "$d/outside"; ln -s "$d/outside" "$R/x"
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && mkdir -p x && echo y > x/y.txt && git add -A && git commit -qm addxy )
NEW=$(git -C "$d/wt" rev-parse HEAD); land env; quiet
expect "nothing written outside through the link" "" "$(ls "$d/outside")"
expect "x/y.txt named in the log as kept" yes "$(log | grep -q 'x/y.txt (not a file here)' && echo yes || echo no)"

echo "== 14 an old lock and old temp directories are cleared, a fresh one is not"
mk
mkdir "$R/.git/junto-follow.lock"; touch -d '5 minutes ago' "$R/.git/junto-follow.lock"
mkdir "$R/.git/junto-follow.abcdef"; touch -d '5 minutes ago' "$R/.git/junto-follow.abcdef"
mkdir "$R/.git/junto-follow.fresh1"
wt_v2; land env; quiet
expect "a stale lock did not stop the follow" "a v2" "$(cat "$R/a.txt")"
expect "old temp directory removed" absent "$([ -e "$R/.git/junto-follow.abcdef" ] && echo present || echo absent)"
expect "fresh temp directory left" present "$([ -e "$R/.git/junto-follow.fresh1" ] && echo present || echo absent)"

echo "== 15 the log line names at most twenty kept paths"
mk
( cd "$R" && mkdir -p many && for i in $(seq 1 25); do echo "m v1 $i" > many/m$i.txt; done && git add -A && git commit -qm many1 )
OLD=$(git -C "$R" rev-parse HEAD)
for i in $(seq 1 25); do echo "m mine $i" > "$R/many/m$i.txt"; done
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && for i in $(seq 1 25); do echo "m v2 $i" > many/m$i.txt; done && git add -A && git commit -qm many2 )
NEW=$(git -C "$d/wt" rev-parse HEAD); land env; quiet
expect "kept 25, five named as more" yes "$(log | grep -q 'kept 25 \[.*+5 more\]' && echo yes || echo no)"
expect "every own edit untouched" 25 "$(grep -l '^m mine ' "$R"/many/m*.txt | wc -l | tr -d ' ')"

echo "== 16 the index sweep: an entry that is an older copy of its path goes to main's, staged work stays"
mk
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "a v2" > a.txt && echo "b v2" > b.txt && git add -A && git commit -qm v2 )
V2=$(git -C "$d/wt" rev-parse HEAD)
NEW=$V2; land env JUNTO_FOLLOW=0                                   # v2 lands with the follow off: checkout and index stay at v1
echo "a mine" > "$R/a.txt"                                          # a.txt: a real edit; its index entry is v1, an older copy
git -C "$R" rm -q --cached d.txt                                   # d.txt: a staged deletion of a file main has
echo "c staged work" > "$R/c.txt"; git -C "$R" add c.txt           # c.txt: staged content no commit holds
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); V3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$V2; NEW=$V3; land env; quiet
expect "a.txt: the real edit is untouched" "a mine" "$(cat "$R/a.txt")"
expect "git status: a.txt a working edit only, b.txt and d.txt clean, c.txt still staged" " M a.txt|M  c.txt|" "$(status)"
expect "log: swept, one left staged with content no commit holds (c.txt)" yes "$(log | grep -q 'swept index entries.*reset 2, left 1 staged with content no commit holds \[c.txt\]' && echo yes || echo no)"

echo "== 17 the working-file sweep: a file left at an older copy by a landing the follow missed is brought to main's"
mk
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "a v2" > a.txt && echo "b v2" > b.txt && git add -A && git commit -qm v2 )
V2=$(git -C "$d/wt" rev-parse HEAD)
NEW=$V2; land env JUNTO_FOLLOW=0                                   # missed: a.txt and b.txt stay v1 here
echo "b mine" > "$R/b.txt"                                          # b.txt is a real edit, not an older copy
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); V3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$V2; NEW=$V3; land env; quiet
expect "a.txt (an older copy) now follows main" "a v2" "$(cat "$R/a.txt")"
expect "b.txt (a real edit) untouched" "b mine" "$(cat "$R/b.txt")"
expect "git status: only the real edit" " M b.txt|" "$(status)"
expect "log names the sweep" yes "$(log | grep -q 'swept working files that were an older copy of main.s: restored 1, kept 0' && echo yes || echo no)"
echo "== 17b the same with the sweeps off"
mk
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "a v2" > a.txt && git add -A && git commit -qm v2 )
V2=$(git -C "$d/wt" rev-parse HEAD); NEW=$V2; land env JUNTO_FOLLOW=0
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); V3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$V2; NEW=$V3; land env JUNTO_FOLLOW_SWEEP=0; quiet
expect "JUNTO_FOLLOW_SWEEP=0: a.txt left as it was" "a v1" "$(cat "$R/a.txt")"

echo "== 18 what the sweep costs: 400 stale working files and 400 stale index entries after one more landing"
mk
( cd "$R" && mkdir -p bulk && for i in $(seq 1 400); do echo "v1 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk1 )
B1=$(git -C "$R" rev-parse HEAD); quiet; rm -f "$R/.git/junto-follow.head"   # no resume point: the missed landing is the sweep's to find
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && for i in $(seq 1 400); do echo "v2 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk2 )
B2=$(git -C "$d/wt" rev-parse HEAD); OLD=$B1; NEW=$B2; land env JUNTO_FOLLOW=0
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); B3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$B2; NEW=$B3; t0=$(ms); land env JUNTO_FOLLOW_BUDGET=60; quiet; t1=$(ms)
expect "all 400 stale working files brought to main's" 400 "$(grep -l '^v2 ' "$R"/bulk/f*.txt | wc -l | tr -d ' ')"
expect "git status clean" "" "$(status)"
echo "      sweep of 400 stale working files: the follower was done $((t1 - t0 - 600)) ms after the landing (600 ms of that is this test's own settle time removed)"
mk
( cd "$R" && mkdir -p bulk && for i in $(seq 1 400); do echo "v1 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk1 )
B1=$(git -C "$R" rev-parse HEAD); quiet; rm -f "$R/.git/junto-follow.head"   # no resume point: the missed landing is the sweep's to find
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && for i in $(seq 1 400); do echo "v2 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk2 )
B2=$(git -C "$d/wt" rev-parse HEAD); OLD=$B1; NEW=$B2; land env JUNTO_FOLLOW=0
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); B3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$B2; NEW=$B3; t0=$(ms); land env JUNTO_FOLLOW_BUDGET=60 JUNTO_FOLLOW_SWEEP_WORK=0; quiet; t1=$(ms)
echo "      the same landing with the working-file sweep off: $((t1 - t0 - 600)) ms (the 400 files stay stale: $(grep -l '^v1 ' "$R"/bulk/f*.txt | wc -l | tr -d ' '))"
mk
( cd "$R" && mkdir -p bulk && for i in $(seq 1 400); do echo "v1 $i" > bulk/f$i.txt; done && git add -A && git commit -qm bulk1 )
B1=$(git -C "$R" rev-parse HEAD)
git -C "$R" worktree add -q -b feat "$d/wt" 2>/dev/null
( cd "$d/wt" && echo "g v3" > g.txt && git add -A && git commit -qm v3 ); B3=$(git -C "$d/wt" rev-parse HEAD)
OLD=$B1; NEW=$B3; t0=$(ms); land env; quiet; t1=$(ms)
echo "      a one-file landing with nothing stale, both sweeps on: the follower was done $((t1 - t0 - 600)) ms after the landing"

echo "== 19 prepared guard: shared checkout stays on main; worktrees and operator override pass"
mk
git -C "$R" checkout -q --detach HEAD 2>/dev/null; rc_detach=$?
expect "shared checkout refuses detached HEAD" 1 "$([ "$rc_detach" -ne 0 ] && echo 1 || echo 0)"
expect "HEAD stays on refs/heads/main after refused detach" "refs/heads/main" "$(git -C "$R" symbolic-ref -q HEAD)"
( cd "$R" && printf 'ref:refs/heads/main ref:refs/heads/side HEAD\n' | "$HOOK" prepared ) 2>/dev/null; rc_sym_hook=$?
expect "prepared guard refuses symref switch off main in shared checkout" 1 "$([ "$rc_sym_hook" -ne 0 ] && echo 1 || echo 0)"
( cd "$R" && printf 'ref:refs/heads/side ref:refs/heads/main HEAD\n' | "$HOOK" prepared ) 2>/dev/null; rc_sym_back=$?
expect "prepared guard allows returning HEAD symref to main" 0 "$rc_sym_back"
( cd "$R" && printf '%s %s refs/heads/main\n%s %s HEAD\n' "$OLD" "$OLD" "$OLD" "$OLD" | "$HOOK" prepared ) 2>/dev/null; rc_main_tx=$?
expect "prepared guard allows commit/update-ref transaction on main" 0 "$rc_main_tx"
git -C "$R" worktree add -q -b wt-feat "$d/wt" 2>/dev/null; rc_wt=$?
expect "git worktree add succeeds from shared checkout" 0 "$rc_wt"
git -C "$d/wt" checkout -q -b wt-side 2>/dev/null; rc_wt_sw=$?
expect "linked worktree can switch branches freely" 0 "$rc_wt_sw"
expect "linked worktree HEAD moved to wt-side" "refs/heads/wt-side" "$(git -C "$d/wt" symbolic-ref -q HEAD)"
( cd "$d/wt" && printf 'ref:refs/heads/wt-side ref:refs/heads/other HEAD\n' | "$HOOK" prepared ) 2>/dev/null; rc_wt_hook=$?
expect "prepared guard ignores linked worktree HEAD" 0 "$rc_wt_hook"
( cd "$R" && echo "a v2" > a.txt && git add a.txt && git commit -qm "commit on main" ) 2>/dev/null; rc_commit=$?
expect "normal commit on main is not blocked by prepared guard" 0 "$rc_commit"
( cd "$R" && printf 'ref:refs/heads/main ref:refs/heads/side HEAD\n' | JUNTO_ALLOW_HEAD_SWITCH=1 "$HOOK" prepared ) 2>/dev/null; rc_override=$?
expect "JUNTO_ALLOW_HEAD_SWITCH=1 lets operator switch branch" 0 "$rc_override"
JUNTO_ALLOW_HEAD_SWITCH=1 git -C "$R" checkout -q --detach HEAD 2>/dev/null; rc_detach_ok=$?
expect "JUNTO_ALLOW_HEAD_SWITCH=1 lets operator detach HEAD" 0 "$rc_detach_ok"
git -C "$R" checkout -q main 2>/dev/null; rc_back=$?
expect "returning to main succeeds without override" 0 "$rc_back"
expect "HEAD is back on refs/heads/main" "refs/heads/main" "$(git -C "$R" symbolic-ref -q HEAD)"

echo
if [ "$fails" = 0 ]; then echo "all checks ok"; else echo "$fails check(s) FAILED"; exit 1; fi
