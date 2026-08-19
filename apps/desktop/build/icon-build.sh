#!/bin/sh
# Rasterise build/icon.svg into the .png and .icns electron-builder ships.
#
# Headless Chrome rather than a dedicated converter: it is the same renderer
# that draws the mark inside the app, so what lands in the dock is what the
# component draws, and it needs no new dependency.
#
# The wrapper HTML is written next to the svg rather than passed as a data: URL,
# because a data: document cannot load a file: image — the first version of this
# script did that and silently produced a blank white square.
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME — set CHROME=..." >&2; exit 1; }

render() { # size, out
  cat > .icon-shot.html <<HTML
<style>html,body{margin:0;padding:0;background:transparent}
img{width:${1}px;height:${1}px;display:block}</style><img src="icon.svg">
HTML
  # `--default-background-color=00000000` is load-bearing and was missing.
  #
  # Headless Chrome composites onto an opaque white backdrop by default, so a
  # screenshot of a page with transparent margins comes out as RGB with those
  # margins *flattened to white* — no alpha channel at all. That is not a
  # cosmetic loss: an app icon's transparency is what tells macOS the shape.
  #
  # It produced three different-looking bugs from one cause. Inset art arrived
  # as a white rounded tile with the mark floating on it; a self-rounded
  # full-bleed tile arrived with white corners, reading as square against its
  # neighbours. Both were diagnosed as macOS re-plating the icon. macOS was
  # doing nothing of the kind — every pixel was already white when it got here.
  #
  # The value is RGBA hex, so `00000000` is transparent black.
  "$CHROME" --headless --disable-gpu --force-device-scale-factor=1 \
    --default-background-color=00000000 \
    --hide-scrollbars --virtual-time-budget=2000 \
    --window-size="$1,$1" --screenshot="$2" "$(pwd)/.icon-shot.html" >/dev/null 2>&1
  rm -f .icon-shot.html
}

render 1024 icon.png
rm -rf icon.iconset && mkdir icon.iconset
# Each entry rendered at its true size — never upscaled — so the 16px tile is
# drawn rather than resampled, which is the whole reason the mark was redrawn.
for s in 16 32 64 128 256 512 1024; do render "$s" "icon.iconset/icon_${s}x${s}.png"; done
for s in 16 32 128 256 512; do
  cp "icon.iconset/icon_$((s*2))x$((s*2)).png" "icon.iconset/icon_${s}x${s}@2x.png"
done
# 64 and 1024 exist only as the @2x sources for 32 and 512; iconutil rejects
# the set if either is left in it under its own name.
rm -f icon.iconset/icon_64x64.png icon.iconset/icon_1024x1024.png
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
echo "icon.png and icon.icns rebuilt from icon.svg"
