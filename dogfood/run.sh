#!/usr/bin/env bash
# Dogfood the evolver pi plugin inside the container: drive a real pi session
# against a mock model and assert Recall, mutation signals, and no automatic Outcome.
set -uo pipefail

MOCK_PORT=18999
export MOCK_PORT
EVOLVER_GRAPH="$HOME/.evolver/memory/evolution/memory_graph.jsonl"
WSID="deadbeefdeadbeefdeadbeefdeadbeef"
export EVOLVER_WORKSPACE_ID="$WSID"
export EVOLVER_SESSION_STATE_DIR="$HOME/.evolver/state"

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

echo "== start mock server =="
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

echo "== run pi headless (evolver plugin installed + mock provider via -e) =="
pi -e /dogfood/mock-provider.ts -p "Write a file named dogfood.txt containing a short test error message, then stop." --mode json >/tmp/out.json 2>/tmp/err.log
PI_EXIT=$?
COUNT_AFTER_FIRST=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
SESSION_FILE=$(find "$EVOLVER_SESSION_STATE_DIR/sessions/$WSID" -type f -name '*.json' -print -quit)
SESSION_ID=$(basename "$SESSION_FILE" .json)
pi --session "$SESSION_ID" -e /dogfood/mock-provider.ts -p "Call evolver_outcome with action set, verdict success, and lesson 'Reuse the verified dogfood workflow', then stop." --mode json >/tmp/outcome.json 2>/tmp/outcome.err
OUTCOME_EXIT=$?
echo "pi exit code: $PI_EXIT"

echo "== assertions =="
check "pi ran without a fatal extension-load error" "! grep -Eiq 'failed to load extension|error loading extension|cannot find module' /tmp/err.log"
check "recall injected on the first turn with durable identity details" "grep -rql '\"customType\":\"evolver-recall\"' \"$HOME/.pi\" 2>/dev/null && grep -rql '\"workspaceId\":\"$WSID\"' \"$HOME/.pi\" 2>/dev/null && grep -rElq '\"recallHash\":\"[a-f0-9]{64}\"' \"$HOME/.pi\" 2>/dev/null"
check "signal detected on the write (Evolution Signal present)" "grep -rql 'Evolution Signal' /tmp/out.json \"$HOME/.pi\" 2>/dev/null"
check "durable Session baseline and accumulated signal survive outside the repository" "find \"$EVOLVER_SESSION_STATE_DIR/sessions/$WSID\" -type f -name '*.json' -print -quit | grep -q . && grep -rql '\"log_error\"' \"$EVOLVER_SESSION_STATE_DIR/sessions/$WSID\" && ! find /work/testrepo -path '*/state/sessions/*' -print -quit | grep -q ."
check "explicit Outcome tool result stays outside model context" "test \"$OUTCOME_EXIT\" -eq 0 && ! grep -Eq '\"content\":\[\{\"type\":\"text\",\"text\":\"(Pending Outcome accepted|Outcome (recorded|already))' /tmp/outcome.json"
check "write tool produced dogfood.txt" "test -f /work/testrepo/dogfood.txt"
NEW_LINES=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
check "quit with no pending Outcome did not fabricate a record ($SEED_LINES -> $COUNT_AFTER_FIRST)" "test \"$COUNT_AFTER_FIRST\" -eq \"$SEED_LINES\""
check "quit after an explicit verified Outcome recorded exactly one line ($COUNT_AFTER_FIRST -> $NEW_LINES)" "test \"$NEW_LINES\" -eq \"$((SEED_LINES + 1))\""
check "recorded Outcome preserves the verified lesson, success status, and explicit source" "tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"status\":\"success\"' && tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"note\":\"Reuse the verified dogfood workflow\"' && tail -1 \"$EVOLVER_GRAPH\" | grep -q '\"source\":\"tool:evolver_outcome\"'"

echo
echo "== result: $PASS passed, $FAIL failed =="
echo "----- mock server log -----"
cat /tmp/mock.log 2>/dev/null || true
if [ "$FAIL" -gt 0 ]; then
	echo "----- pi stderr (tail) -----"
	tail -30 /tmp/err.log 2>/dev/null || true
	echo "----- last recorded outcome -----"
	tail -1 "$EVOLVER_GRAPH" 2>/dev/null || true
fi
kill "$MOCK_PID" 2>/dev/null || true
exit "$FAIL"
