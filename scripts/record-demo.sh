#!/usr/bin/env bash
# Record a GIF from a running Tower. Boots nothing itself — start the Tower
# first (npm run build && npm start), then: bash scripts/record-demo.sh
# Seeds a worktree shell run if the fleet is empty, drives the Flightline with Playwright,
# and converts the recorded webm to a palette-optimized gif. Needs: node, ffmpeg, and
# Playwright's chromium (npx playwright install chromium). Output goes in a new directory
# under OUTDIR (default: system temp). Review it before sharing: the walkthrough records an
# existing terminal and can show project paths, the shell prompt, and machine information.
set -euo pipefail

PORT="${CT_PORT:-4870}"
BASE="http://127.0.0.1:${PORT}"
ORIGIN="Origin: ${BASE}"
OUTDIR="${OUTDIR:-${TMPDIR:-/tmp}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUTDIR"
OUTDIR=$(mktemp -d "$OUTDIR/ct-demo.XXXXXXXX")

jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{$1}catch(e){console.log('')}})"; }

TOK=$(curl -s -H "$ORIGIN" "$BASE/api/session" | jget "console.log(JSON.parse(s).token)")
[ -n "$TOK" ] || { echo "no Tower on $BASE — start it first"; exit 1; }

# Prefer a non-sandbox (real git repo) project so the worktree + Review tab are meaningful.
PID=$(curl -s -H "$ORIGIN" -H "X-Tower-Token: $TOK" "$BASE/api/projects" | jget "const a=JSON.parse(s);console.log(((a.find(p=>p.name!=='sandbox'))||a[0]||{}).id||'')")
LIVE=$(curl -s -H "$ORIGIN" -H "X-Tower-Token: $TOK" "$BASE/api/terminals" | jget "console.log(JSON.parse(s).filter(t=>t.state!=='killed').length)")

if [ "${LIVE:-0}" -eq 0 ] && [ -n "$PID" ]; then
  echo "seeding a worktree shell run in project $PID…"
  curl -s -o /dev/null -H "$ORIGIN" -H "X-Tower-Token: $TOK" -H 'Content-Type: application/json' \
    -d "{\"projectId\":\"$PID\",\"provider\":\"shell\",\"worktree\":true,\"taskLabel\":\"demo\"}" "$BASE/api/terminals" || true
  sleep 2
fi

WEBM=$(PORT="$PORT" OUTDIR="$OUTDIR" node "$ROOT/scripts/make-demo.mjs")
echo "recorded: $WEBM"

PALETTE="$OUTDIR/palette.png"
ffmpeg -y -i "$WEBM" -vf "fps=15,scale=960:-1:flags=lanczos,palettegen" "$PALETTE" >/dev/null 2>&1
ffmpeg -y -i "$WEBM" -i "$PALETTE" -lavfi "fps=15,scale=960:-1:flags=lanczos [x]; [x][1:v] paletteuse" "$OUTDIR/demo.gif" >/dev/null 2>&1
echo "wrote: $OUTDIR/demo.gif"
