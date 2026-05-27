#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Installing JavaScript dependencies..."
npm ci

echo "Generating native iOS project..."
npx expo prebuild --platform ios --clean

WORKSPACE="$(find ios -maxdepth 2 -name "*.xcworkspace" -print -quit)"
if [[ -z "${WORKSPACE}" ]]; then
  echo "Could not find an iOS workspace."
  exit 1
fi

SCHEME="$(xcodebuild -list -json -workspace "$WORKSPACE" | ruby -rjson -e 'data = JSON.parse(STDIN.read); puts data.dig("workspace", "schemes")&.first')"
if [[ -z "${SCHEME}" ]]; then
  echo "Could not detect an Xcode scheme."
  exit 1
fi

echo "Building unsigned iOS app with scheme: ${SCHEME}"
rm -rf build unsigned-ipa MathScapeAI-unsigned.ipa

xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

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
