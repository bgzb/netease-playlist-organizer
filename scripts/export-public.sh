#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:-public-release}"
if [[ $# -gt 1 || ! "$name" =~ ^public-[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    printf '%s\n' 'Usage: export-public.sh [public-unique-name] (new directory under work/)' >&2
    exit 1
fi
destination="$root/work/$name"
if [[ -e "$destination" || -L "$destination" ]]; then
    printf '%s\n' 'Public export destination already exists; choose a new name.' >&2
    exit 1
fi
# This rebuilds the sanitized ZIP from a clean committed HEAD before any extraction.
bash "$root/scripts/package-source.sh"
mkdir "$destination"
trap 'rm -rf "$destination"' EXIT
/usr/bin/unzip -q "$root/work/dist/网易云歌单整理源码.zip" -d "$destination"
# Flatten the archive prefix. No repository is initialized and no history is copied.
shopt -s dotglob
mv "$destination/netease-playlist-organizer/"* "$destination/"
rmdir "$destination/netease-playlist-organizer"
trap - EXIT
printf 'Exported committed source %s -> %s\n' "$(git -C "$root" rev-parse HEAD)" "$destination"
