#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# Ship committed sources only. A dirty index/worktree must be resolved before archiving.
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    printf '%s\n' 'Source package requires a clean committed tree (ignored work/build/cache files are not packaged).' >&2
    exit 1
fi
files=()
while IFS= read -r -d '' file; do
    case "$file" in
        .git/*|node_modules/*|work/*|.superpowers/*|launcher/.build/*|cache/*|caches/*|*/cache/*|*/caches/*|private-evidence/*|*/private-evidence/*|*/.DS_Store|.DS_Store|docs/read-verification.md|docs/access-verification.md|docs/design.md|docs/implementation-plan.md) continue ;;
    esac
    files+=("$file")
done < <(git ls-tree -r -z --name-only HEAD)
[[ ${#files[@]} -gt 0 ]] || { printf '%s\n' 'No committed source files.' >&2; exit 1; }
mkdir -p "$root/work/dist"
archive="$root/work/dist/网易云歌单整理源码.zip"
temporary="$root/work/dist/.source-archive.$$.zip"
trap 'rm -f "$temporary"' EXIT
# Git ZIP comment carries the exact commit; no working-tree/private files enter this archive.
git archive --format=zip --prefix=netease-playlist-organizer/ --output="$temporary" HEAD -- "${files[@]}"
/usr/bin/unzip -tq "$temporary"
mv "$temporary" "$archive"
printf 'Packaged committed source %s -> %s\n' "$(git rev-parse HEAD)" "$archive"
