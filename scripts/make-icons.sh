#!/usr/bin/env bash
# Regenerates every derived Wolfreader image from the single source logo.
# Requires ImageMagick 6 (`convert`). Output:
#   build/icon.ico               Windows app/installer icon (16–256 px)
#   build/icon.png               512 px badge (window icon on Linux dev runs)
#   build/installerSidebar.bmp   NSIS welcome/finish sidebar (164x314)
#   src/renderer/img/logo.png        full logo, transparent background (welcome + About)
#   src/renderer/img/logo-badge.png  round badge (title bar mark)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/branding/wolfreader-logo-source.jpg"
BUILD="$ROOT/build"
IMG="$ROOT/src/renderer/img"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$BUILD" "$IMG"

# 1. Full logo with the black background removed (flood fill from the corners),
#    edges softened slightly so it sits cleanly on any colour.
convert "$SRC" -alpha set -fuzz 9% -fill none \
  -draw "matte 0,0 floodfill" -draw "matte 1253,0 floodfill" \
  -draw "matte 0,1253 floodfill" -draw "matte 1253,1253 floodfill" \
  -channel A -blur 0x0.8 -level 30%,100% +channel \
  -trim +repage -gravity center -background none -extent 1180x1180 \
  "$TMP/full.png"

# 2. Round badge: wolf face + book (no wordmark), framed by the logo's brown ring.
convert "$SRC" -crop 700x700+330+150 +repage -resize 1024x1024 "$TMP/crop.png"
convert -size 1024x1024 xc:none -fill white -draw "circle 512,512 512,40" "$TMP/mask.png"
convert "$TMP/crop.png" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$TMP/inner.png"
convert -size 1024x1024 xc:none -fill "#3a2016" -draw "circle 512,512 512,2" \
  "$TMP/inner.png" -compose over -composite "$TMP/badge.png"

# 3. Windows .ico: badge for small sizes (legible at 16–64 px), full logo for 128/256.
for s in 16 24 32 48 64; do
  convert "$TMP/badge.png" -filter Lanczos -resize ${s}x${s} -unsharp 0x0.6 "$TMP/ico-$s.png"
done
for s in 128 256; do
  convert "$TMP/full.png" -filter Lanczos -resize ${s}x${s} "$TMP/ico-$s.png"
done
convert "$TMP"/ico-16.png "$TMP"/ico-24.png "$TMP"/ico-32.png "$TMP"/ico-48.png \
  "$TMP"/ico-64.png "$TMP"/ico-128.png "$TMP"/ico-256.png "$BUILD/icon.ico"
convert "$TMP/badge.png" -resize 512x512 "$BUILD/icon.png"

# 4. NSIS sidebar: lamp-lit brown gradient with the logo.
convert -size 164x314 gradient:"#4a2a1b"-"#1f120c" \
  \( "$TMP/full.png" -resize 140x140 \) -gravity north -geometry +0+36 -composite \
  -fill "#f3e3c6" -font DejaVu-Serif -pointsize 11 -gravity south -annotate +0+40 "Open. Read. Print." \
  -alpha off -type truecolor BMP3:"$BUILD/installerSidebar.bmp"

# 5. In-app images.
convert "$TMP/full.png" -filter Lanczos -resize 560x560 -strip "$IMG/logo.png"
convert "$TMP/badge.png" -filter Lanczos -resize 128x128 -strip "$IMG/logo-badge.png"

# 6. Wordmark only (cream lettering, transparent) for the dark title bar: keep the
#    light pixels of the banner lettering, masking the tail tip above and the book icon below.
convert "$SRC" -crop 870x185+200+893 +repage \
  \( +clone -colorspace HSL -channel L -separate +channel -level 62%,88% \
     -fill black -draw "rectangle 0,0 260,24" -draw "rectangle 300,166 560,185" \) \
  -alpha off -compose CopyOpacity -composite -trim +repage \
  -filter Lanczos -resize x72 -strip "$IMG/wordmark.png"

identify "$BUILD/icon.ico" "$BUILD/installerSidebar.bmp" "$IMG/logo.png" "$IMG/logo-badge.png" "$IMG/wordmark.png"
