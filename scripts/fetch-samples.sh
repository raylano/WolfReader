#!/usr/bin/env bash
# Downloads the public-domain Project Gutenberg EPUBs used by the end-to-end
# tests into test/samples/ (git-ignored). Uses the gutenberg.pglaf.org mirror.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/test/samples"
MIRROR="https://gutenberg.pglaf.org/cache/epub"
mkdir -p "$DEST"

fetch() {
  local name="$1" url="$2"
  if [ -s "$DEST/$name" ]; then
    echo "have  $name"
  else
    echo "fetch $name"
    curl -sSfL --max-time 300 -o "$DEST/$name.part" "$url"
    mv "$DEST/$name.part" "$DEST/$name"
  fi
}

# Clean EPUB 3 with a proper nav TOC (Alice's Adventures in Wonderland, #11)
fetch alice-pg11-images-3.epub "$MIRROR/11/pg11-images-3.epub"
# Image-heavy: Arthur Rackham's illustrated Alice (#28885)
fetch alice-rackham-pg28885-images-3.epub "$MIRROR/28885/pg28885-images-3.epub"
# Large: War and Peace (#2600) as EPUB 3 and as EPUB 2 (NCX TOC, 365 files)
fetch war-and-peace-pg2600-images-3.epub "$MIRROR/2600/pg2600-images-3.epub"
fetch war-and-peace-pg2600-epub2.epub "$MIRROR/2600/pg2600.epub"

ls -l "$DEST"
