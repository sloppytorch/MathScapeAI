#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p build
exec > >(tee build/full-build.log) 2>&1

echo "Installing JavaScript dependencies..."
npm ci

echo "Generating native iOS project..."
npx expo prebuild --platform ios --clean --no-install

echo "Refreshing CocoaPods dependencies..."
rm -rf "$HOME/Library/Developer/Xcode/DerivedData/MathScapeAI-"*
(
  cd ios
  rm -rf Pods Podfile.lock
  set +e
  pod install --repo-update --verbose 2>&1 | tee ../build/pod-install.log
  POD_STATUS=${PIPESTATUS[0]}
  set -e
  if [[ "$POD_STATUS" -ne 0 ]]; then
    echo "pod install failed with status ${POD_STATUS}. Last 240 log lines:"
    tail -240 ../build/pod-install.log
    exit "$POD_STATUS"
  fi
)

WORKSPACE="$(find ios -maxdepth 2 -name "*.xcworkspace" -print -quit)"
if [[ -z "${WORKSPACE}" ]]; then
  echo "Could not find an iOS workspace."
  exit 1
fi

SCHEMES_JSON="$(xcodebuild -list -json -workspace "$WORKSPACE")"
echo "Available Xcode schemes:"
echo "$SCHEMES_JSON" | ruby -rjson -e 'data = JSON.parse(STDIN.read); puts(data.dig("workspace", "schemes") || [])'

SCHEME="$(echo "$SCHEMES_JSON" | ruby -rjson -e 'data = JSON.parse(STDIN.read); schemes = data.dig("workspace", "schemes") || []; puts schemes.find { |s| !s.start_with?("Pods-") }')"
if [[ -z "${SCHEME}" ]]; then
  echo "Could not detect an Xcode scheme."
  exit 1
fi

echo "Building unsigned iOS app with scheme: ${SCHEME}"
rm -rf build/DerivedData unsigned-ipa MathScapeAI-unsigned.ipa
mkdir -p build

echo "Pre-seeding CocoaPods module maps for Swift app compilation..."
PRODUCTS_DIR="$ROOT_DIR/build/DerivedData/Build/Products/Release-iphoneos"
mkdir -p "$PRODUCTS_DIR"
for POD_NAME in EXConstants Expo ExpoAsset ExpoDomWebView ExpoFileSystem ExpoFont ExpoImagePicker ExpoKeepAwake ExpoLogBox ExpoModulesCore RCTSwiftUI; do
  SUPPORT_DIR="$ROOT_DIR/ios/Pods/Target Support Files/$POD_NAME"
  DEST_DIR="$PRODUCTS_DIR/$POD_NAME"
  if [[ -d "$SUPPORT_DIR" ]]; then
    mkdir -p "$DEST_DIR"
    cp "$SUPPORT_DIR"/*.modulemap "$DEST_DIR/" 2>/dev/null || true
    cp "$SUPPORT_DIR"/*-umbrella.h "$DEST_DIR/" 2>/dev/null || true
  fi
done

set +e
CODE_SIGNING_ALLOWED=NO \
CODE_SIGNING_REQUIRED=NO \
CODE_SIGN_IDENTITY="" \
CODE_SIGN_STYLE=Manual \
DEVELOPMENT_TEAM="" \
PROVISIONING_PROFILE_SPECIFIER="" \
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -destination "generic/platform=iOS" \
  -derivedDataPath build/DerivedData \
  -jobs 1 \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build 2>&1 | tee build/xcodebuild.log
XCODE_STATUS=${PIPESTATUS[0]}
set -e

if [[ "$XCODE_STATUS" -ne 0 ]]; then
  echo "xcodebuild failed with status ${XCODE_STATUS}. Last 200 log lines:"
  tail -200 build/xcodebuild.log
  exit "$XCODE_STATUS"
fi

APP_PATH="$(find build/DerivedData/Build/Products/Release-iphoneos -maxdepth 1 -name "*.app" -type d -print -quit)"
if [[ -z "${APP_PATH}" ]]; then
  echo "Could not find the built .app bundle."
  exit 1
fi

echo "Packaging unsigned IPA from: ${APP_PATH}"
mkdir -p unsigned-ipa/Payload
cp -R "$APP_PATH" unsigned-ipa/Payload/

(
  cd unsigned-ipa
  zip -qry "../MathScapeAI-unsigned.ipa" Payload
)

echo "Created MathScapeAI-unsigned.ipa"
