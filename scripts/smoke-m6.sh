#!/usr/bin/env bash
set +e
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
CTH=/tmp/ct-m6; PORT=4883; B="http://127.0.0.1:$PORT"; O="Origin: http://127.0.0.1:$PORT"
PROJDIR="$PWD/examples/e2e-project"
kill_t () { local p; p=$(ss -ltnHp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$p" ] && kill "$p" 2>/dev/null; sleep 1; }
start_t () { setsid env CT_HOME=$CTH CT_PORT=$PORT CT_TEST_MAX_SLOTS=2 npx tsx src/server/server.ts > /tmp/ct-m6.log 2>&1 & sleep 3; }
J () { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log($1)}catch(e){console.log('ERR:'+s.slice(0,80))}})"; }

kill_t; rm -rf "$CTH"; start_t
TOK=$(curl -s -H "$O" "$B/api/session" | J "o.token"); A=(-H "$O" -H "X-Tower-Token: $TOK")
curl -s "${A[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"e2eproj\",\"repoPath\":\"$PROJDIR\"}" "$B/api/projects" >/dev/null
PID=$(curl -s "${A[@]}" "$B/api/projects" | J "o.find(p=>p.name==='e2eproj').id")
TID=$(curl -s "${A[@]}" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"provider\":\"shell\"}" "$B/api/terminals" | J "o.id")
sleep 1; HT="$CTH/secrets/hooktok-$TID"

echo "--- 1. real Playwright run via towerctl test (slots empty) ---"
( cd "$PROJDIR" && env TOWER_PORT=$PORT TOWER_HOOK_TOKEN_FILE="$HT" npx tsx "$ROOT/src/cli/towerctl.ts" test run 2>&1 | tail -5 )
echo "  runs recorded: $(curl -s "${A[@]}" "$B/api/testruns" | J "'n='+o.length+' latest='+(o[0]?o[0].status:'-')")"
echo "  blob report file(s): $(ls $CTH/testruns/*/blob/ 2>/dev/null | grep -c .)"

echo "--- 2. slot semaphore: acquire up to cap (2) then 503 ---"
acq () { curl -s -o /dev/null -w '%{http_code}' -H "$O" -H "X-Tower-Terminal-Token: $(cat $HT)" -X POST "$B/api/agent/test/acquire"; }
echo "  #1=$(acq) #2=$(acq) #3=$(acq) (expect 200 200 503)"

echo "--- 3. token survives Tower restart (agent can still use the kit) ---"
kill_t; start_t
TOK=$(curl -s -H "$O" "$B/api/session" | J "o.token"); A=(-H "$O" -H "X-Tower-Token: $TOK")
echo "  capacity via terminal token after restart: http=$(curl -s -o /dev/null -w '%{http_code}' -H "$O" -H "X-Tower-Terminal-Token: $(cat $HT)" -X POST "$B/api/agent/test/acquire") (expect 200, token re-registered)"

echo "  audit test events: $(grep -c 'test.acquire\|test.release' "$CTH/audit.log" 2>/dev/null)"
kill_t
D="/tmp/tmux-$(id -u)"; for s in $(ls "$D" 2>/dev/null | grep '^ct-'); do tmux -L "$s" kill-server 2>/dev/null; rm -f "$D/$s"; done
echo "=== done ==="
