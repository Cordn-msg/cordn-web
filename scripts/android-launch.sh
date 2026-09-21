#!/usr/bin/env bash
# Boots the cordn AVD (created on first run), installs the debug APK, launches the app.
# One-time env prerequisite: sdkmanager "emulator" "system-images;android-36;google_apis;x86_64"
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
AVD=cordn
IMG="system-images;android-36;google_apis;x86_64"

if ! "$EMU" -list-avds | grep -qx "$AVD"; then
  echo "no" | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD" -k "$IMG" -d pixel_7
fi

if ! "$ADB" get-state >/dev/null 2>&1; then
  nohup "$EMU" -avd "$AVD" >/dev/null 2>&1 &
fi

"$ADB" wait-for-device
"$ADB" shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'

APK=$(ls -t android/app/build/outputs/apk/debug/*.apk | head -1)
"$ADB" install -r "$APK"
"$ADB" shell am start -n org.cordn.app/org.cordn.app.MainActivity
