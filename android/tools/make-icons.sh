#!/usr/bin/env bash
# Generates the launcher icon set for Motion Studio.
# Requires ImageMagick (`convert`). Output: app/src/main/res/mipmap-*/ic_launcher.png
set -euo pipefail
cd "$(dirname "$0")/.."          # -> android/
RES="app/src/main/res"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- legacy square icon (rounded corners baked in) -------------------------
convert -size 1024x1024 "gradient:#2c1f52-#0a1018" \
  -rotate 180 \
  -draw "fill '#57ddce33' stroke none circle 512,512 512,940" \
  -draw "fill none stroke '#8a63e8' stroke-width 34 stroke-dasharray 900 620 circle 512,512 512,760" \
  -draw "fill none stroke '#57ddce' stroke-width 34 stroke-dasharray 700 900 circle 512,512 512,660" \
  -draw "fill '#f7f8fb' path 'M 452,392 L 452,632 L 664,512 Z'" \
  -draw "fill none stroke '#ffffff14' stroke-width 6 roundrectangle 8,8 1016,1016 190,190" \
  "$TMP/icon_base.png"

# ---- adaptive foreground (content inside the 66% safe zone) ----------------
convert -size 1024x1024 xc:none \
  -draw "fill '#57ddce22' stroke none circle 512,512 512,620" \
  -draw "fill none stroke '#8a63e8' stroke-width 26 stroke-dasharray 640 470 circle 512,512 512,690" \
  -draw "fill none stroke '#57ddce' stroke-width 26 stroke-dasharray 500 640 circle 512,512 512,620" \
  -draw "fill '#f7f8fb' path 'M 468,428 L 468,596 L 606,512 Z'" \
  "$TMP/icon_fg.png"

# ---- adaptive background ---------------------------------------------------
convert -size 1024x1024 "gradient:#2c1f52-#0a1018" -rotate 180 "$TMP/icon_bg.png"

sizes_mdpi=48; sizes_hdpi=72; sizes_xhdpi=96; sizes_xxhdpi=144; sizes_xxxhdpi=192
for spec in "mdpi:$sizes_mdpi" "hdpi:$sizes_hdpi" "xhdpi:$sizes_xhdpi" "xxhdpi:$sizes_xxhdpi" "xxxhdpi:$sizes_xxxhdpi"; do
  d="${spec%%:*}"; s="${spec##*:}"
  mkdir -p "$RES/mipmap-$d"
  convert "$TMP/icon_base.png" -resize "${s}x${s}" "$RES/mipmap-$d/ic_launcher.png"
  convert "$TMP/icon_fg.png" -resize "${s}x${s}" "$RES/mipmap-$d/ic_launcher_foreground.png"
  convert "$TMP/icon_bg.png" -resize "${s}x${s}" "$RES/mipmap-$d/ic_launcher_background.png"
done

mkdir -p "$RES/mipmap-anydpi-v26"
cat > "$RES/mipmap-anydpi-v26/ic_launcher.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML

echo "icons written to $RES/mipmap-*"
