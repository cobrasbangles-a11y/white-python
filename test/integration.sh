#!/bin/bash
# End-to-end check against a REAL browser on a REAL display — the layer unit
# tests can't reach. Every command is run and its output scanned for crashes,
# window counts are read back from the window manager, and the run fails if
# anything is left open.
#
# Needs: an X display (Xvfb is fine), a window manager, and a browser
# configured via `wpy config browser=...`. Not part of `npm test`, which stays
# dependency-free and headless.
#
#   Xvfb :99 -screen 0 1920x1080x24 &
#   DISPLAY=:99 openbox &
#   DISPLAY=:99 bash test/integration.sh
cd "$(dirname "$0")/.."
export DISPLAY=:99
export WHITE_PYTHON_HOME=${WHITE_PYTHON_HOME:-/tmp/wp-integration}
FAIL=0
W() { wmctrl -l 2>/dev/null | wc -l | tr -d ' '; }
run() {
  desc="$1"; shift
  out=$("$@" 2>&1); code=$?
  bad=$(printf '%s' "$out" | grep -icE 'is not a function|TypeError|ReferenceError|Cannot read|undefined is not|NaN|ENOENT.*white-python|Unhandled|stack')
  if [ $code -ne 0 ] || [ "$bad" != "0" ]; then
    echo "  FAIL [$desc] exit=$code"; printf '%s\n' "$out" | head -5 | sed 's/^/        /'
    FAIL=$((FAIL+1))
  else
    echo "  ok   [$desc]"
  fi
}
N=node; B=bin/white-python.js

echo "--- read-only commands ---"
for c in help version feeds displays doctor debug config status stats; do run "$c" $N $B $c; done

echo "--- config set/get ---"
run "config layout"   $N $B config layout=phones
run "config feeds x3" $N $B config feeds=http://127.0.0.1:8899/tiktok.html,http://127.0.0.1:8899/instagram.html,http://127.0.0.1:8899/youtube.html
run "config browser"  $N $B config browser=$WHITE_PYTHON_HOME/chrome
run "config back"     $N $B config layout=columns openDelayMs=2000

echo "--- on/off ---"
run "off" $N $B off
run "on"  $N $B on

echo "--- open / close with a real browser ---"
run "open" $N $B open --session it
sleep 12; echo "       windows after open: $(W)  (want 3)"
[ "$(W)" = "3" ] || { echo "  FAIL open produced $(W) windows"; FAIL=$((FAIL+1)); }
run "status(open)" $N $B status
run "close" $N $B close --session it
sleep 3; echo "       windows after close: $(W)  (want 0)"
[ "$(W)" = "0" ] || { echo "  FAIL close left $(W) windows"; FAIL=$((FAIL+1)); }

echo "--- hook lifecycle, all four reasons ---"
S='{"session_id":"it2"}'
for reason in question done session-end; do
  echo "$S" | $N $B hook start >/dev/null 2>&1
  sleep 4
  n1=$(W)
  echo "$S" | $N $B hook stop --reason $reason >/dev/null 2>&1
  sleep 3
  n2=$(W)
  if [ "$n1" = "3" ] && [ "$n2" = "0" ]; then echo "  ok   [hook $reason: 3 -> 0]"
  else echo "  FAIL [hook $reason: $n1 -> $n2, want 3 -> 0]"; FAIL=$((FAIL+1)); fi
done

echo "--- start / stop ---"
run "start" $N $B start --session it3
sleep 4; s1=$(W)
run "stop"  $N $B stop --session it3
sleep 3; s2=$(W)
[ "$s1" = "3" ] && [ "$s2" = "0" ] && echo "  ok   [start/stop 3 -> 0]" || { echo "  FAIL [start/stop $s1 -> $s2]"; FAIL=$((FAIL+1)); }

echo "--- wrap ---"
run "wrap exit 0" $N $B wrap -- sh -c 'sleep 4'
$N $B wrap -- sh -c 'exit 9' >/dev/null 2>&1; [ $? -eq 9 ] && echo "  ok   [wrap exit code 9]" || { echo "  FAIL wrap exit code"; FAIL=$((FAIL+1)); }
run "wrap --idle" $N $B wrap --idle 2 -- sh -c 'echo a; sleep 5; echo b'

echo "--- login (piped Enter) ---"
( sleep 14; printf '\n' ) | $N $B login >/tmp/login.out 2>&1
grep -q "profile stored" /tmp/login.out && echo "  ok   [login stored profiles]" || { echo "  FAIL login"; sed 's/^/        /' /tmp/login.out | head -6; FAIL=$((FAIL+1)); }

echo "--- install / uninstall ---"
T=$(mktemp -d); mkdir -p "$T/.claude"; echo '{"permissions":{"allow":["x"]}}' > "$T/.claude/settings.json"
( cd "$T" && $N "$PWD/$B" install >/dev/null 2>&1 && $N "$PWD/$B" uninstall >/dev/null 2>&1 )
if [ "$(cat "$T/.claude/settings.json" | tr -d ' \n')" = '{"permissions":{"allow":["x"]}}' ]; then
  echo "  ok   [install/uninstall round trip]"
else echo "  FAIL settings not restored: $(cat "$T/.claude/settings.json")"; FAIL=$((FAIL+1)); fi
rm -rf "$T"

echo "--- leftovers ---"
lw=$(W); lp=$(ps -eo stat,args --no-headers | grep 'chrome-linux/chrome' | grep -v '^Z' | grep -vc grep || echo 0)
echo "       windows: $lw   live chrome: $lp"
[ "$lw" = "0" ] && echo "  ok   [nothing left open]" || { echo "  FAIL $lw windows left"; FAIL=$((FAIL+1)); }

echo
echo "================= FAILURES: $FAIL ================="
exit $FAIL
