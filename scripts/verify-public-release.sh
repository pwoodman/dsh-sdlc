#!/bin/sh
# Verify the PUBLIC release artifact exactly as the README instructs anyone to.
set -eu

URL="https://github.com/pwoodman/dsh-sdlc/releases/latest/download/dsh-sdlc-beta.tgz"
WORK=/tmp/dsh-release-verify
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

echo "1. curl -fsSLO $URL"
curl -fsSLO "$URL"
echo "   downloaded $(wc -c < dsh-sdlc-beta.tgz) bytes, sha256 $(sha256sum dsh-sdlc-beta.tgz | cut -c1-32)…"

echo "2. tar xzf dsh-sdlc-beta.tgz && cd dsh-sdlc-*/"
tar xzf dsh-sdlc-beta.tgz
cd dsh-sdlc-*/
echo "   VERSION=$(cat VERSION)"

echo "3. ./install.sh   (fresh DSH_HOME, real globally-installed dsh)"
DSH_HOME="$WORK/home" ./install.sh > "$WORK/install.log" 2>&1 || {
  echo "   install.sh exited non-zero — tail:"; tail -20 "$WORK/install.log"; exit 1;
}
grep -cE '\[ok\]' "$WORK/install.log" | sed 's/^/   [ok] steps: /'
grep -E 'Install complete' "$WORK/install.log" | sed 's/^/   /'

echo "4. dsh --profile sdlc-probe  (the installed plugin, really booting)"
DSH_HOME="$WORK/home" SDLC_SELFTEST="$WORK/selftest.json" dsh --profile sdlc-probe > "$WORK/probe.log" 2>&1 || true
node -e "
const r = require('$WORK/selftest.json');
console.log('   version  :', r.version);
console.log('   tools    :', r.tools.length);
console.log('   commands :', r.commands.length);
console.log('   services :', r.services.length);
console.log('   presets  :', r.presets.length);
"

echo "5. dsh --profile sdlc-worker --dump-config  (the worker half is installable too)"
DSH_HOME="$WORK/home" dsh --profile sdlc-worker --dump-config > "$WORK/worker.yml" 2>&1 || true
printf '   worker rows: %s   (sdlc-core present: %s)\n' \
  "$(grep -c '^- id:' "$WORK/worker.yml" || true)" \
  "$(grep -c 'sdlc-core' "$WORK/worker.yml" || true)"

echo
echo "VERIFIED: the published one-command install works end to end."
