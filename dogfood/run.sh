#!/usr/bin/env bash
# Deterministic, network-isolated Pi dogfood for the evolver plugin.
# Drives the agent (tool) and user (slash-command) submission paths against a
# loopback mock provider and asserts the full local core end-to-end.
# Runtime gate: docker run --rm --network none evolver-dogfood
set -uo pipefail

MOCK_PORT=18999
export MOCK_PORT
EVOLVER_GRAPH="$HOME/.evolver/memory/evolution/memory_graph.jsonl"
WSID="deadbeefdeadbeefdeadbeefdeadbeef"
export EVOLVER_WORKSPACE_ID="$WSID"
export EVOLVER_SESSION_STATE_DIR="$HOME/.evolver/state"
PLUGIN="-e /dogfood/mock-provider.ts"
export PI_USAGE_QUERY_NO_OPEN=1

PASS=0
FAIL=0
check() {
	if eval "$2"; then
		echo "  PASS: $1"
		PASS=$((PASS + 1))
	else
		echo "  FAIL: $1"
		FAIL=$((FAIL + 1))
	fi
}

# Count mock chat/completions calls recorded in $1 since the last marker.
mock_calls() { local n; n=$(grep -c 'chat/completions #' "$1" 2>/dev/null); echo "${n:-0}"; }
mark_mock() { : > "$1"; }
session_id_of() { jq -r '.id // empty' "$1" 2>/dev/null | head -1; }

echo "== start mock server =="
: >/tmp/mock.log
node /dogfood/mock-server.mjs 2>/tmp/mock.log &
MOCK_PID=$!
sleep 1

echo "== set default provider/model =="
SETTINGS="$HOME/.pi/agent/settings.json"
mkdir -p "$HOME/.pi/agent"
[ -f "$SETTINGS" ] || echo '{}' >"$SETTINGS"
jq '. + {defaultProvider:"mock", defaultModel:"mock-model"}' "$SETTINGS" >"$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "== prepare clean test git repo =="
rm -rf /work/testrepo && mkdir -p /work/testrepo && cd /work/testrepo
git init -q && git config user.email t@t.t && git config user.name t
echo "hello" >a.txt && git add -A && git commit -qm init

echo "== seed a recent successful outcome so recall has something to inject =="
mkdir -p "$(dirname "$EVOLVER_GRAPH")"
printf '%s\n' "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"gene_id\":\"ad_hoc\",\"signals\":[\"capability_gap\"],\"outcome\":{\"status\":\"success\",\"score\":0.8,\"note\":\"seeded prior success for recall\"},\"cwd\":\"/work/testrepo\",\"workspace_id\":\"$WSID\",\"session_id\":\"seed\",\"diff_hash\":\"seed\",\"diff_scope\":\"working_tree\",\"source\":\"tool:evolver_outcome\"}" >"$EVOLVER_GRAPH"
SEED_LINES=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
echo "seeded $SEED_LINES outcome(s)"

PI="pi $PLUGIN --mode json"

echo "== [agent] S1: startup recall + real mutation (write dogfood.txt) =="
mark_mock /tmp/m1.log
$PI -p "Write a file named dogfood.txt containing a short test error message, then stop." >/tmp/s1.json 2>/tmp/s1.err
S1_EXIT=$?
AFTER_S1=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
SESSION_ID=$(session_id_of /tmp/s1.json)
echo "pi exit code: $S1_EXIT"

echo "== [agent] S1 resume: real evolver_outcome tool set (success) =="
$PI --session "$SESSION_ID" -p "Call evolver_outcome with action set, verdict success, and lesson 'Reuse the verified dogfood workflow', then stop." >/tmp/s2.json 2>/tmp/s2.err
AFTER_TOOL=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')

echo "== [agent] S1 resume: reload/idempotency — no re-injected recall, no new record =="
$PI --session "$SESSION_ID" -p "Stop now." >/tmp/s3.json 2>/tmp/s3.err
AFTER_RELOAD=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')

echo "== [agent] content-preserving commit must not create a new record =="
git add -A && git commit -qm "same content" 2>/dev/null
AFTER_COMMIT=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')

echo "== [agent] S2 fresh: subsequent Recall includes the newly recorded outcome + dedup =="
$PI --no-session -p "Stop now." >/tmp/s4.json 2>/tmp/s4.err
AFTER_S2=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
# Re-submit the same transition under S2 — must dedup.
$PI --no-session -p "Call evolver_outcome with action set, verdict success, lesson 'Reuse the verified dogfood workflow', then stop." >/tmp/s5.json 2>/tmp/s5.err
AFTER_DEDUP=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')

echo "== [user] S3 fresh: real mutation (file2.txt) for the command-sourced flow =="
$PI -p "Write a file named file2.txt containing a test, then stop." >/tmp/s6.json 2>/tmp/s6.err
S3_ID=$(session_id_of /tmp/s6.json)

echo "== [user] S3 resume: /evolver-outcome failed (command-sourced, no model call) =="
mark_mock /tmp/m7.log
$PI --session "$S3_ID" -p "/evolver-outcome failed avoid-this-approach" >/tmp/s7.json 2>/tmp/s7.err
AFTER_CMD=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
CMD_MOCK_CALLS=$(mock_calls /tmp/m7.log)
AFTER_CMD=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
CMD_MOCK_CALLS=$(mock_calls /tmp/m7.log)
echo "== [user] S4: /evolver-status (no model call, no mutation) =="
mark_mock /tmp/m8.log
GRAPH_BEFORE_STATUS=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
$PI --no-session -p "/evolver-status" >/tmp/s8.json 2>/tmp/s8.err
STATUS_MOCK_CALLS=$(mock_calls /tmp/m8.log)
GRAPH_AFTER_STATUS=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')

echo
echo "== assertions =="
check "pi ran without a fatal extension-load error" "! grep -Eiq 'failed to load extension|error loading extension|cannot find module' /tmp/s1.err"
check "recall injected on the first turn with durable identity details" "grep -rql '\"customType\":\"evolver-recall\"' \"$HOME/.pi\" 2>/dev/null && grep -rql '\"workspaceId\":\"$WSID\"' \"$HOME/.pi\" 2>/dev/null && grep -rElq '\"recallHash\":\"[a-f0-9]{64}\"' \"$HOME/.pi\" 2>/dev/null"
check "recall is bounded to 2,000 characters" "grep -rEo '\"content\":\"\\[Evolution Memory\\][^\"]{0,2100}' \"$HOME/.pi\" 2>/dev/null | head -1 | wc -c | awk '{exit (\$1 > 2030) ? 1 : 0}'"
check "signal detected on the write (Evolution Signal present)" "grep -rql 'Evolution Signal' /tmp/s1.json \"$HOME/.pi\" 2>/dev/null"
check "durable Session baseline and accumulated signal survive outside the repository" "find \"$EVOLVER_SESSION_STATE_DIR/sessions/$WSID\" -type f -name '*.json' -print -quit | grep -q . && grep -rql '\"log_error\"' \"$EVOLVER_SESSION_STATE_DIR/sessions/$WSID\" && ! find /work/testrepo -path '*/state/sessions/*' -print -quit | grep -q ."
check "write tool produced dogfood.txt" "test -f /work/testrepo/dogfood.txt"
check "quit with no pending Outcome did not fabricate a record ($SEED_LINES -> $AFTER_S1)" "test \"$AFTER_S1\" -eq \"$SEED_LINES\""
check "tool-sourced Outcome recorded exactly one line ($AFTER_S1 -> $AFTER_TOOL)" "test \"$AFTER_TOOL\" -eq \"$((SEED_LINES + 1))\""
check "recorded tool Outcome preserves success status, score 0.8, lesson, and source" "grep -q '\"status\":\"success\"' \"$EVOLVER_GRAPH\" && grep -q '\"score\":0.8' \"$EVOLVER_GRAPH\" && grep -q '\"note\":\"Reuse the verified dogfood workflow\"' \"$EVOLVER_GRAPH\" && grep -q '\"source\":\"tool:evolver_outcome\"' \"$EVOLVER_GRAPH\" && grep -q '\"signals\":\\[\"log_error\"\\]' \"$EVOLVER_GRAPH\""
check "durable result slot records the last finalization attempt" "test -f \"$EVOLVER_SESSION_STATE_DIR/results/$WSID.json\" && grep -q '\"lastAttempt\"' \"$EVOLVER_SESSION_STATE_DIR/results/$WSID.json\""
check "reload/idempotency: no re-injected recall and no new record ($AFTER_TOOL -> $AFTER_RELOAD)" "test \"$AFTER_RELOAD\" -eq \"$AFTER_TOOL\""
check "content-preserving commit created no new record ($AFTER_RELOAD -> $AFTER_COMMIT)" "test \"$AFTER_COMMIT\" -eq \"$AFTER_RELOAD\""
check "subsequent fresh-session Recall mentions the newly recorded lesson" "grep -rql 'Reuse the verified dogfood workflow' \"$HOME/.pi\" 2>/dev/null"
check "re-submitting the same transition deduplicated ($AFTER_S2 -> $AFTER_DEDUP)" "test \"$AFTER_DEDUP\" -eq \"$AFTER_S2\""
check "user /evolver-outcome failed recorded a command-sourced line ($AFTER_S2 -> $AFTER_CMD)" "test \"$AFTER_CMD\" -eq \"$((AFTER_S2 + 1))\""
check "command-sourced Outcome preserves failed status, score 0.3, lesson, and command source" "tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"status\":\"failed\"' && tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"score\":0.3' && tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"note\":\"avoid-this-approach\"' && tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"source\":\"command:evolver-outcome\"'"
check "user /evolver-outcome caused no model call ($CMD_MOCK_CALLS calls)" "test \"$CMD_MOCK_CALLS\" -eq 0"
check "user command result stayed outside model context" "! grep -Eq '\"content\":\[\{\"type\":\"text\",\"text\":\"(Pending Outcome|Outcome (recorded|queued))' /tmp/s7.json"
check "/evolver-status caused no model call ($STATUS_MOCK_CALLS calls)" "test \"$STATUS_MOCK_CALLS\" -eq 0"
check "/evolver-status created no new Graph record ($GRAPH_BEFORE_STATUS -> $GRAPH_AFTER_STATUS)" "test \"$GRAPH_AFTER_STATUS\" -eq \"$GRAPH_BEFORE_STATUS\""
check "no Hub/external-network dependency was required (--network none survived)" "! grep -Eiq 'ECONNREFUSED|ENOTFOUND|ECONN|getaddrinfo|external' /tmp/s1.err /tmp/s2.err /tmp/s7.err /tmp/s8.err"

echo
echo "== result: $PASS passed, $FAIL failed =="
echo "----- mock server log -----"
cat /tmp/mock.log 2>/dev/null || true
if [ "$FAIL" -gt 0 ]; then
	echo "----- pi stderr (tails) -----"
	tail -20 /tmp/s1.err 2>/dev/null || true
	tail -20 /tmp/s7.err 2>/dev/null || true
	echo "----- last recorded outcome -----"
	tail -1 "$EVOLVER_GRAPH" 2>/dev/null || true
fi
kill "$MOCK_PID" 2>/dev/null || true
exit "$FAIL"
