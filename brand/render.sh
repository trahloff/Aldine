#!/bin/sh
# Rebuilds every raster and copied logo file from the drawings in brand/.
# Needs rsvg-convert (librsvg) and ImageMagick 7.
#
#   icon.svg      the app icon, drawn for 48px and up (hairline edge)
#   icon-32.svg   the same at 32px: larger "a", larger dot, no hairline
#   icon-16.svg   16px: the "a" alone, enlarged
#   wordmark.svg  "aldine." outlined from Geist SemiBold (SIL OFL 1.1);
#                 apps/web/src/components/Wordmark.tsx carries the same paths
# apps/web/index.html inlines icon-32.svg as the app's favicon.
set -eu
cd "$(dirname "$0")"
site=../site
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

rsvg-convert -w 16 -h 16 icon-16.svg -o "$tmp/16.png"
rsvg-convert -w 32 -h 32 icon-32.svg -o "$tmp/32.png"
rsvg-convert -w 48 -h 48 icon.svg -o "$tmp/48.png"
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$site/favicon.ico"

# iOS rounds the corners itself: square tile, no hairline
sed -e 's/ rx="22"//' -e 's/<rect x=".5"[^>]*>//' icon.svg > "$tmp/touch.svg"
rsvg-convert -w 180 -h 180 "$tmp/touch.svg" -o "$site/apple-touch-icon.png"

# a tab shows the SVG at 16 CSS px, 32 device px on most screens
cp icon-32.svg "$site/favicon.svg"
cp wordmark.svg "$site/assets/wordmark.svg"
