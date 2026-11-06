#!/usr/bin/env bash
# Behaviour tests for gpu-run, with dummy commands only (no GPU work, no real lock).
# Every path and endpoint points at a temp dir and a local stub of mindmeld + ComfyUI.
#   bash scripts/gpu/gpu-run.test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
GR="$HERE/gpu-run"
T=$(mktemp -d)
export GPU_RUN_LOCK=$T/gpu.flock GPU_RUN_STATUS=$T/gpu.status GPU_RUN_QUEUE=$T/gpu.queue \
  GPU_RUN_MIRROR=$T/cast-walks/GPU-WAN.lock GPU_RUN_POLL=1
unset GPU_RUN_HOLDER

cat >"$T/stub.py" <<'PY'
import http.server, json, sys
log = open(sys.argv[1], "a", buffering=1)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, body):
        b = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.reply({"status": "ok", "standingDown": True, "secondsRemaining": 7200})
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        log.write(f"POST {self.path} {body}\n"); self.reply({"status": "ok"})
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 -I "$T/stub.py" "$T/http.log" >"$T/port" &
STUB=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port")
export GPU_RUN_COMFY_URL=http://127.0.0.1:$PORT GPU_RUN_MINDMELD_URL=http://127.0.0.1:$PORT
trap 'kill $STUB 2>/dev/null; pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT

pass=0 fail=0
ok() { echo "PASS $*"; pass=$((pass + 1)); }
bad() { echo "FAIL $*"; fail=$((fail + 1)); }
now() { date +%s.%N; }
held() { ! "$GR" --status | grep -q '^free'; }
# held, and the job started: the status file names its process group
running() { held && python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["pgid"] is None)' "$GPU_RUN_STATUS" 2>/dev/null; }
wait_held() { for _ in $(seq 100); do running && return 0; sleep 0.1; done; echo "(timed out waiting for a holder)"; return 1; }
jobs_wait() { local p; for p in $(jobs -p); do [ "$p" = "$STUB" ] || wait "$p" 2>/dev/null; done; }  # never the stub
wait_free() { for _ in $(seq 100); do held || return 0; sleep 0.1; done; return 1; }

echo "== 1. two concurrent gpu-runs serialize"
"$GR" --label A -- bash -c "echo A start \$(date +%s.%N) >>$T/order; sleep 2; echo A end \$(date +%s.%N) >>$T/order" 2>/dev/null &
wait_held
"$GR" --label B -- bash -c "echo B start \$(date +%s.%N) >>$T/order" 2>/dev/null &
jobs_wait
a_end=$(awk '/A end/{print $3}' "$T/order"); b_start=$(awk '/B start/{print $3}' "$T/order")
cat "$T/order"
if awk -v a="$a_end" -v b="$b_start" 'BEGIN{exit !(b >= a)}'; then ok "B started $(awk -v a="$a_end" -v b="$b_start" 'BEGIN{printf "%.2f", b-a}')s after A ended"; else bad "B started before A ended"; fi

echo "== 2. waiters run in arrival order"
: >"$T/fifo"
"$GR" --label hold -- sleep 2 2>/dev/null &
wait_held
for w in w1 w2 w3; do "$GR" --label "$w" -- bash -c "echo $w >>$T/fifo" 2>/dev/null & sleep 0.4; done
"$GR" --status | sed 's/^/   /'
jobs_wait
order=$(tr '\n' ' ' <"$T/fifo")
[ "$order" = "w1 w2 w3 " ] && ok "order: $order" || bad "order: $order"

echo "== 3. SIGKILL of the holder frees the lock at once"
"$GR" --label victim -- sleep 60 2>/dev/null &
victim=$!
wait_held
child=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pgid"])' "$GPU_RUN_STATUS")
t0=$(now); kill -KILL "$victim"; wait "$victim" 2>/dev/null
"$GR" --wait 5 --label next -- bash -c "echo ran >$T/next; cat $GPU_RUN_STATUS >$T/next.status" 2>/dev/null; rc=$?
t1=$(now)
dt=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')
[ "$rc" = 0 ] && [ -f "$T/next" ] && ok "next holder ran ${dt}s after SIGKILL" || bad "next holder rc=$rc after SIGKILL"
sleep 0.2
kill -0 "$child" 2>/dev/null && bad "job $child survived its killed gpu-run" || ok "the killed holder's job (pid $child) died with it (pdeathsig)"
grep -q '"label": "next"' "$T/next.status" && ok "next holder replaced the stale status" || bad "stale status not replaced"

echo "== 3c. a job orphaned by that SIGKILL is waited for, not run over"
# bash (the direct child) dies with gpu-run; the sh it started survives, like a python
# step under a batch script, and is the one that writes orphan-done
"$GR" --label batch -- bash -c "sh -c 'sleep 2.5; echo orphan-done \$(date +%s.%N) >>$T/orphan'; true" 2>/dev/null &
victim=$!
wait_held
kill -KILL "$victim"; wait "$victim" 2>/dev/null
"$GR" --label after -- bash -c "echo after-start \$(date +%s.%N) >>$T/orphan" 2>/dev/null
cat "$T/orphan"
o_end=$(awk '/orphan-done/{print $2}' "$T/orphan"); a_start=$(awk '/after-start/{print $2}' "$T/orphan")
[ -n "$o_end" ] && awk -v a="$o_end" -v b="$a_start" 'BEGIN{exit !(b >= a)}' && ok "next holder started after the orphaned sleep ended" || bad "next holder overlapped the orphaned job"

echo "== 3b. SIGKILL of the whole job tree (a crash) frees the lock"
setsid "$GR" --label tree -- bash -c 'sleep 60 & sleep 60' 2>/dev/null &
tree=$!
wait_held
kill -KILL -- "-$tree" "-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pgid"])' "$GPU_RUN_STATUS")"
wait_free && ok "free after killing every process" || bad "still held after killing every process"

echo "== 4. a nested gpu-run does not deadlock"
out=$(timeout 10 "$GR" --label outer -- "$GR" --label inner -- echo nested-ran 2>&1); rc=$?
[ "$rc" = 0 ] && grep -q nested-ran <<<"$out" && ok "nested ran (rc 0): $(grep nested <<<"$out" | head -1)" || bad "nested rc=$rc: $out"

echo "== 5. status file and mirror exist only while held"
: >"$T/http.log"
"$GR" --label "aim e take2" -- sleep 1.5 2>/dev/null &
wait_held
during_status=$([ -f "$GPU_RUN_STATUS" ] && echo yes || echo no)
during_mirror=$(head -1 "$GPU_RUN_MIRROR" 2>/dev/null)
who=$("$GR" --who | python3 -c 'import json,sys; print(json.load(sys.stdin)["label"])')
jobs_wait
[ "$during_status" = yes ] && [ "$who" = "aim e take2" ] && ok "during: status present, --who label '$who'" || bad "during: status=$during_status who=$who"
[[ "$during_mirror" == "gpu-run | aim e take2 | pid "* ]] && ok "during: mirror '$(cut -c1-40 <<<"$during_mirror")...'" || bad "during: mirror '$during_mirror'"
[ ! -e "$GPU_RUN_STATUS" ] && [ ! -e "$GPU_RUN_MIRROR" ] && ok "after: both removed" || bad "after: status or mirror left behind"
"$GR" --who >/dev/null; [ $? = 1 ] && ok "--who exits 1 when free" || bad "--who did not exit 1 when free"

echo "== 6. stand-down before, ComfyUI /free after, none with --keep-models"
grep -q 'POST /api/stand-down {"minutes": 120, "reason": "gpu-run: aim e take2"}' "$T/http.log" && ok "stand-down extended to 120 min (stub had 7200 s left)" || bad "stand-down: $(cat "$T/http.log")"
grep -q 'POST /free {"unload_models":true,"free_memory":true}' "$T/http.log" && ok "/free posted" || bad "/free missing"
: >"$T/http.log"
"$GR" --keep-models --label keep -- true 2>/dev/null
grep -q '/free' "$T/http.log" && bad "--keep-models still posted /free" || ok "--keep-models: no /free"

echo "== 7. --wait timeout exits non-zero without running"
"$GR" --label long -- sleep 6 2>/dev/null &
wait_held
t0=$(now); "$GR" --wait 2 --label late -- touch "$T/late-ran" 2>/dev/null; rc=$?; t1=$(now)
[ "$rc" = 75 ] && [ ! -e "$T/late-ran" ] && ok "rc 75 after $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')s, command not run" || bad "rc=$rc late-ran=$([ -e "$T/late-ran" ] && echo yes)"
grep -q late "$GPU_RUN_QUEUE" && bad "timed-out waiter left in the queue" || ok "timed-out waiter left the queue"
jobs_wait

echo "== 8. SIGTERM reaches the job; exit code and stdin pass through"
"$GR" --label term -- bash -c "trap 'echo got-term >$T/term; exit 143' TERM; sleep 60 & wait" 2>/dev/null &
p=$!; wait_held; kill -TERM "$p"; wait "$p"; rc=$?
[ "$rc" = 143 ] && grep -q got-term "$T/term" && ok "job got SIGTERM, rc 143" || bad "rc=$rc term=$(cat "$T/term" 2>/dev/null)"
wait_free && ok "free after SIGTERM" || bad "held after SIGTERM"
"$GR" -- bash -c 'exit 7' 2>/dev/null; rc=$?; [ "$rc" = 7 ] && ok "command rc 7 passed through" || bad "rc $rc"
got=$(echo piped | "$GR" -- cat 2>/dev/null); [ "$got" = piped ] && ok "stdin reaches the command" || bad "stdin: '$got'"

echo "== 9. a hand-made GPU-WAN.lock is honoured and never deleted"
mkdir -p "$(dirname "$GPU_RUN_MIRROR")"; echo "old-worker 2026-11-06: hand lock" >"$GPU_RUN_MIRROR"
"$GR" --wait 2 --label blocked -- touch "$T/legacy-ran" 2>/dev/null; rc=$?
[ "$rc" = 75 ] && [ ! -e "$T/legacy-ran" ] && ok "waited on the hand lock (rc 75)" || bad "ran despite hand lock (rc $rc)"
[ -f "$GPU_RUN_MIRROR" ] && ok "hand lock left in place" || bad "hand lock deleted"
"$GR" --ignore-legacy -- true 2>/dev/null; grep -q old-worker "$GPU_RUN_MIRROR" && ok "--ignore-legacy ran and left the hand lock" || bad "--ignore-legacy clobbered the hand lock"
rm -f "$GPU_RUN_MIRROR"

echo
echo "gpu-run tests: $pass passed, $fail failed"
[ "$fail" = 0 ]
