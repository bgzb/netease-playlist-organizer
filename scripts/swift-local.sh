#!/bin/bash
# Build/test helper for CLT installations with mixed public/private SwiftPM interfaces.
# Repairs only a copy under this repository's ignored work directory.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
swift_bin="${SWIFT_BIN:-$(/usr/bin/xcrun --find swift)}"
toolchain="$(cd "$(dirname "$swift_bin")/../.." && pwd)"
manifest="$toolchain/usr/lib/swift/pm/ManifestAPI"
module="$manifest/PackageDescription.swiftmodule"
arch="$(/usr/bin/uname -m)"
public="$module/$arch-apple-macos.swiftinterface"
private="$module/$arch-apple-macos.private.swiftinterface"
if [[ -f "$public" && -f "$private" ]] && [[ "$(/usr/bin/sed -n '2p' "$public")" != "$(/usr/bin/sed -n '2p' "$private")" ]]; then
    local_libs="$root/work/swiftpm-libs"
    mkdir -p "$local_libs/ManifestAPI/PackageDescription.swiftmodule"
    cp "$manifest/libPackageDescription.dylib" "$local_libs/ManifestAPI/"
    cp "$public" "$local_libs/ManifestAPI/PackageDescription.swiftmodule/"
    export SWIFTPM_CUSTOM_LIBS_DIR="$local_libs"
fi
if [[ "${1:-}" == test ]] && [[ -d "$toolchain/Library/Developer/Frameworks/Testing.framework" ]]; then
    exec "$swift_bin" "$@" -Xswiftc -F -Xswiftc "$toolchain/Library/Developer/Frameworks" \
        -Xlinker -rpath -Xlinker "$toolchain/Library/Developer/Frameworks" \
        -Xlinker -rpath -Xlinker "$toolchain/Library/Developer/usr/lib"
fi
exec "$swift_bin" "$@"
