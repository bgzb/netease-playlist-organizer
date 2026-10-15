#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source="$root/assets/app-icon.png"
[[ -s "$source" ]] || { printf '%s\n' 'Missing application icon: assets/app-icon.png' >&2; exit 1; }
mkdir -p "$root/work/dist"
temporary="$(mktemp -d "$root/work/icon-build.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
iconset="$temporary/OrganizerIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    /usr/bin/sips -s format png -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -s format png -z "$double" "$double" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$root/work/dist/OrganizerIcon.icns"
printf 'Built %s\n' "$root/work/dist/OrganizerIcon.icns"
