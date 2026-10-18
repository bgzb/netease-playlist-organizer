#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
panel="$root/work/dist/panel.js"
if [[ "$(/usr/bin/uname -m)" != arm64 ]]; then
    printf '%s\n' 'This release is supported and packaged only for Mac arm64.' >&2
    exit 1
fi
if [[ ! -s "$panel" ]]; then
    printf '%s\n' 'Missing real panel bundle: work/dist/panel.js. Build the implemented panel first with npm run build:panel.' >&2
    exit 1
fi
"$root/scripts/swift-local.sh" build --package-path "$root/launcher" -c release
binary_dir="$("$root/scripts/swift-local.sh" build --package-path "$root/launcher" -c release --show-bin-path)"
bash "$root/scripts/build-icon.sh"
app="$root/work/dist/网易云歌单整理.app"
# Only replace this project's own generated bundle.
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary_dir/OrganizerLauncher" "$app/Contents/MacOS/OrganizerLauncher"
/usr/bin/lipo "$app/Contents/MacOS/OrganizerLauncher" -verify_arch arm64
cp "$panel" "$app/Contents/Resources/panel.js"
cp "$root/work/dist/OrganizerIcon.icns" "$app/Contents/Resources/OrganizerIcon.icns"
cp "$root/LICENSE" "$app/Contents/Resources/LICENSE"
cp "$root/THIRD_PARTY_NOTICES.md" "$app/Contents/Resources/THIRD_PARTY_NOTICES.md"
# Verify the packaged resource is exactly the implemented bundle, before signing.
cmp "$panel" "$app/Contents/Resources/panel.js"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.netease-playlist-organizer.launcher</string>
<key>CFBundleName</key><string>网易云歌单整理</string>
<key>CFBundleDisplayName</key><string>网易云歌单整理</string>
<key>CFBundleExecutable</key><string>OrganizerLauncher</string>
<key>CFBundleIconFile</key><string>OrganizerIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>5</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><false/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$app/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --strict "$app"
/usr/bin/shasum -a 256 "$app/Contents/MacOS/OrganizerLauncher" "$app/Contents/Resources/panel.js"
printf 'Built %s\n' "$app"

# Seal the signed bytes without extended attributes, then validate an extracted copy.
# Some delivery folders add FinderInfo again; the plain ZIP is the stable distribution.
archive="$root/work/dist/网易云歌单整理应用.zip"
temporary="$root/work/dist/.app-archive.$$.zip"
validation="$(mktemp -d /private/tmp/ncm-organizer-archive.XXXXXX)"
trap 'rm -f "$temporary"; rm -rf "$validation"' EXIT
(cd "$root/work/dist" && /usr/bin/zip -q -X -r "$temporary" '网易云歌单整理.app')
/usr/bin/unzip -tq "$temporary"
/usr/bin/unzip -q "$temporary" -d "$validation"
extracted="$validation/网易云歌单整理.app"
/usr/bin/codesign --verify --strict "$extracted"
/usr/bin/lipo "$extracted/Contents/MacOS/OrganizerLauncher" -verify_arch arm64
cmp "$app/Contents/MacOS/OrganizerLauncher" "$extracted/Contents/MacOS/OrganizerLauncher"
cmp "$panel" "$extracted/Contents/Resources/panel.js"
cmp "$root/work/dist/OrganizerIcon.icns" "$extracted/Contents/Resources/OrganizerIcon.icns"
cmp "$root/LICENSE" "$extracted/Contents/Resources/LICENSE"
cmp "$root/THIRD_PARTY_NOTICES.md" "$extracted/Contents/Resources/THIRD_PARTY_NOTICES.md"
mv "$temporary" "$archive"
/usr/bin/shasum -a 256 "$archive"
printf 'Sealed and verified %s\n' "$archive"
