#!/bin/bash
# Static checks for Unstuck: JavaScript syntax, JSON validity, and the
# service worker shell matching the files actually on disk.
set -euo pipefail
cd "$(dirname "$0")"

status=0

for f in logic.js sw.js scripts/make_icons.js tests/*.test.js; do
  node --check "$f" && echo "syntax ok: $f" || status=1
done

for f in manifest.webmanifest .well-known/assetlinks.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" \
    && echo "json ok: $f" || status=1
done

# The inline app script is not a standalone file, so extract it to check it.
python3 - <<'PY' > /tmp/unstuck-inline.js
html = open('index.html').read()
start = html.index('<script>', html.index('logic.js'))
print(html[start + len('<script>'):html.index('</script>', start)])
PY
node --check /tmp/unstuck-inline.js && echo "syntax ok: index.html inline script" || status=1
rm -f /tmp/unstuck-inline.js

# Every shell entry the service worker promises must exist.
python3 - <<'PY' || status=1
import os, re, sys
sw = open('sw.js').read()
shell = re.search(r'const SHELL = \[(.*?)\];', sw, re.S).group(1)
missing = [p for p in re.findall(r"'\./([^']*)'", shell) if p and not os.path.exists(p)]
if missing:
    print('sw.js caches files that do not exist:', ', '.join(missing)); sys.exit(1)
print('sw shell ok: every cached path exists')
PY

echo "GHA: N/A -- no workflows in this repo"
exit "$status"
