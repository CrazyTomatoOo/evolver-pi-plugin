#!/usr/bin/env bash
# Dogfood the evolver pi plugin inside the container: drive a real pi session
# against a mock model and assert all three automatic behaviors fire.
set -uo pipefail

MOCK_PORT=18999
export MOCK_PORT
EVOLVER_GRAPH="$HOME/.evolver/memory/evolution/memory_graph.jsonl"
WSID="deadbeefdeadbeefdeadbeefdeadbeef"
export EVOLVER_WORKSPACE_ID="$WSID"

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

echo "== prepare test git repo with a working-tree diff =="
rm -rf /work/testrepo && mkdir -p /work/testrepo && cd /work/testrepo
git init -q && git config user.email t@t.t && git config user.name t
echo "hello" >a.txt && git add -A && git commit -qm init
echo "change" >>a.txt # working-tree change so session-end has a diff to classify

echo "== seed a recent successful outcome so recall has something to inject =="
mkdir -p "$(dirname "$EVOLVER_GRAPH")"
printf '%s\n' "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"gene_id\":\"ad_hoc\",\"signals\":[\"stable_success_plateau\"],\"outcome\":{\"status\":\"success\",\"score\":0.8,\"note\":\"seeded prior success for recall\"},\"cwd\":\"/work/testrepo\",\"workspace_id\":\"$WSID\",\"session_id\":\"seed\",\"diff_hash\":\"seed\",\"diff_scope\":\"working_tree\",\"source\":\"hook:session-end\"}" >"$EVOLVER_GRAPH"
SEED_LINES=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
echo "seeded $SEED_LINES outcome(s)"

echo "== run pi headless (evolver plugin installed + mock provider via -e) =="
pi -e /dogfood/mock-provider.ts -p "Write a file named dogfood.txt containing a short test error message, then stop." --mode json >/tmp/out.json 2>/tmp/err.log
PI_EXIT=$?
echo "pi exit code: $PI_EXIT"

echo "== assertions =="
check "pi ran without a fatal extension-load error" "! grep -Eiq 'failed to load extension|error loading extension|cannot find module' /tmp/err.log"
check "recall injected (Evolution Memory present)" "grep -rql 'Evolution Memory' /tmp/out.json \"$HOME/.pi\" 2>/dev/null"
check "signal detected on the write (Evolution Signal present)" "grep -rql 'Evolution Signal' /tmp/out.json \"$HOME/.pi\" 2>/dev/null"
check "write tool produced dogfood.txt" "test -f /work/testrepo/dogfood.txt"
NEW_LINES=$(wc -l <"$EVOLVER_GRAPH" | tr -d ' ')
check "session-end recorded a NEW outcome ($SEED_LINES -> $NEW_LINES)" "test \"$NEW_LINES\" -gt \"$SEED_LINES\""
HOOK_COUNT=$(grep -c 'hook:session-end' "$EVOLVER_GRAPH")
check "recorded outcome sourced from hook:session-end (count=$HOOK_COUNT > 1)" "test '$HOOK_COUNT' -gt 1"

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
