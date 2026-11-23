#!/bin/sh
# Rebuilds the evidence for #308. Run from the repo root; needs playwright's chromium (see repro.ts's import).
set -e
S=${1:-/tmp/308}
for rev in 45764a5c:before 5171cb6e:after; do
  sha=${rev%%:*}; d=$S/css/${rev##*:}; mkdir -p "$d/ui" "$d/timelines" "$d/previews"
  for f in ui/theme.css ui/icon.module.css ui/button.module.css timelines/sidebar.module.css timelines/line.module.css timelines/inlines.module.css previews/message-previews.module.css previews/preview-image.module.css previews/larger-view.module.css previews/play-button.module.css; do
    git show "$sha:apps/web/src/$f" > "$d/$f"
  done
done
mkdir -p "$S/out"
for v in before after; do bun 308/repro.ts "$S/css" "$S/out" $v; done
