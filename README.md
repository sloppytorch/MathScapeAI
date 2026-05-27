# MathScape AI

MathScape AI is an Expo React Native app for iOS that combines an AI math solver with a spatial infinite whiteboard.

## Install

1. Install Node.js 22 or newer.
2. Install the Expo Go app on your iPhone.
3. In this folder, run:

```powershell
npm install
npm start
```

4. Scan the QR code with Expo Go.
5. Open Settings in the app and paste your NVIDIA API key.

## Build An iPhone IPA

To create an Apple-signed installable iOS build, use EAS Build:

```powershell
npx eas-cli login
npx eas-cli build:configure
npx eas-cli build --platform ios --profile preview
```

For a real iPhone IPA, Apple requires signing. EAS will guide you through Apple Developer login, certificates, and device registration.

## Build An Unsigned IPA For A Third-Party Signer

This project includes a GitHub Actions workflow that builds an unsigned IPA on a macOS runner:

```text
.github/workflows/build-unsigned-ios.yml
```

Steps:

1. Push this project to a GitHub repository.
2. Open the repository on GitHub.
3. Go to Actions.
4. Choose Build Unsigned iOS IPA.
5. Click Run workflow.
6. Download the MathScapeAI-unsigned-ipa artifact.
7. Import `MathScapeAI-unsigned.ipa` into your signer.

The unsigned IPA build script is:

```text
scripts/build-unsigned-ipa.sh
```

## NVIDIA NIM

The app calls:

```text
https://integrate.api.nvidia.com/v1/chat/completions
```

Default model:

```text
meta/llama-3.2-90b-vision-instruct
```

For production, use a small backend proxy instead of calling NVIDIA directly from the mobile client.
