#!/bin/sh
# Usage: native/reminders-helper/build.sh <out-dir>
# A persistent certificate and bundle identifier keep the same Reminders grant.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: build.sh <out-dir>}
identity=${RK_SIGNING_IDENTITY:-Reminders Kanban Dev}
if [ "${RK_COMPILE_ONLY:-0}" != 1 ]; then
    identities=$(security find-identity -v -p codesigning 2>/dev/null || true)
    fingerprint=$(printf '%s\n' "$identities" | awk -v requested="$identity" '
        /^[[:space:]]*[0-9]+\)/ {
            hash=$2; name=$0; sub(/^[^"]*"/, "", name); sub(/".*$/, "", name)
            if (toupper(hash) == toupper(requested) || name == requested) {
                if (!seen[hash]++) { count++; selected=hash }
            }
        }
        END { if (count == 1) print selected }')
    if [ -z "$fingerprint" ]; then
        echo "signing_required: prepare a persistent local signing identity" >&2
        exit 78
    fi
fi
if ! xcode-select -p >/dev/null 2>&1; then
    echo "toolchain_required: install Apple's Command Line Tools" >&2
    exit 79
fi
compiler=$(xcrun --find swiftc 2>/dev/null) || {
    echo "toolchain_required: Swift compiler unavailable" >&2
    exit 79
}
app="$out/RK Reminders Helper.app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
# EventKit's full-access request requires macOS 14. A newer inferred deployment target
# can make LaunchServices reject the helper on the Mac that just compiled it.
xcrun --sdk macosx swiftc -O -target "$(uname -m)-apple-macosx${RK_MACOS_TARGET:-14.0}" "$here"/*.swift -o "$app/Contents/MacOS/reminders-helper"
if [ "${RK_COMPILE_ONLY:-0}" != 1 ]; then
    if ! codesign --force --sign "$fingerprint" "$app"; then
        echo "signing_required: unlock the login keychain and try preparing again" >&2
        exit 78
    fi
    codesign --verify --deep --strict "$app"
fi
echo "$app"
