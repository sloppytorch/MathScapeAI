# MathScape AI

MathScape AI is an Expo React Native app for iOS that combines an AI math solver with a spatial infinite whiteboard.

## Expo Go Install

1. Install Node.js 22 or newer.
2. Install the Expo Go app on your iPhone.
3. In this folder, run:

```powershell
npm install
npx expo start --tunnel --clear
```

4. Scan the QR code with Expo Go.
5. Open Settings in the app and paste your NVIDIA API key.

If the tunnel is slow, use LAN instead:

```powershell
npx expo start --lan --clear
```

## Build An iPhone IPA

To create an Apple-signed installable iOS build, use EAS Build:

```powershell
npx eas-cli login
npx eas-cli build:configure
npx eas-cli build --platform ios --profile preview
```

For a real iPhone IPA, Apple requires signing. EAS will guide you through Apple Developer login, certificates, and device registration.

## Build An Unsigned IPA For A Third-Party Signer

This project includes a GitHub Actions workflow that builds a Release unsigned IPA on a macOS runner:

```text
.github/workflows/build-unsigned-ios.yml
```

The build script refuses to package the IPA unless the app contains `main.jsbundle`. That prevents Debug-style IPAs that install but black-screen or crash when Metro is not running.

Steps:

1. Push this project to a GitHub repository.
2. Open the repository on GitHub.
3. Go to Actions.
4. Choose Build Unsigned iOS IPA.
5. Use the latest successful run after the Release bundle fix.
6. Download the `MathScapeAI-unsigned-ipa` artifact.
7. Unzip the artifact.
8. Import `MathScapeAI-unsigned.ipa` into your signer.

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

Recommended production flow:

1. Mobile app sends the typed problem, optional image, and whiteboard JSON to your backend.
2. Backend attaches the NVIDIA API key from server environment variables.
3. Backend calls NVIDIA NIM and returns only the parsed solution/feedback JSON to the app.
4. The mobile app never stores or ships a shared production API key.

## Serviceability Checklist

- The app has a startup error boundary instead of a blank crash screen.
- Typed problem, latest solution, whiteboard objects, feedback, image, and API key persist locally.
- Missing key, bad key, no network, and invalid AI JSON show visible retryable errors.
- The board supports text cards, solution cards, image cards, feedback cards, pan, zoom, joystick navigation, reset, and new problem.
- Release IPA builds verify `Payload/MathScapeAI.app/main.jsbundle` before upload.
