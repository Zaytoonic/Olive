<p align="center"><img src="assets/olive-icon-1024.png" width="96" alt="Olive icon"></p>
<h1 align="center">Olive</h1>
<p align="center">A microphone manager for Windows, inspired by SteelSeries Sonar's mic tab.</p>
<p align="center"><a href="https://github.com/Zaytoonic/Olive/releases/latest"><strong>Download the latest version</strong></a></p>

![The Olive window](docs/screenshot.png)

## Features
- **Voice cleanup:** RNNoise noise reduction with adjustable strength, and a noise gate that opens on your voice.
- **Compressor** to even out your volume.
- **Six-band EQ** with a low cut and presets, saved separately for each mic, and a hold-to-compare button.
- **Send to Discord or other apps** through [VB-Audio Virtual Cable](https://vb-audio.com/Cable/).
- **Windows mic volume and mute**, with a mute hotkey that works from anywhere and a short sound when you mute or unmute.
- **Push to talk** on any key or side mouse button.
- **Listen** to hear your processed mic live, on the output device you choose.
- **Runs in the tray**, and can start with Windows.

## Installing
Download `Olive-Setup-<version>.exe` from [Releases](https://github.com/Zaytoonic/Olive/releases/latest) and run it. It installs for your Windows account, with no admin rights needed, and adds a Start menu shortcut and an uninstaller. The app is not code-signed yet, so Windows may say "Windows protected your PC": click **More info**, then **Run anyway**.

Olive checks GitHub once a day for a new version and tells you if there is one. It never downloads or installs anything by itself, and you can turn the check off.

## Using it with Discord
1. Install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) and restart your PC.
2. In Olive, choose your mic and leave **Send to Discord / other apps** on.
3. In Discord, open **Voice & Video** and set the input device to **CABLE Output**.

## Building from source
You need Windows and [Node.js](https://nodejs.org/).
```
npm install
npm run update-runtime
npm run build
npm run patch-exe
```
The app is then at `dist\Olive\Olive.exe`. Keep it in its folder. Closing the window hides it to the tray; to quit, right-click the tray icon.

To run it from source instead, use `npm start`.

To build the installer, run `npm run installer`, which creates `dist\Olive-Setup-<version>.exe`. `npm run test:installer` tests it end to end, kept apart from your real install. To code-sign it, see the top of `tools/sign.js`.

## After changing the code
Quit Olive first, because `npm run build` won't run while it's open.
1. `npm run build` copies `src` and `assets` into `dist/Olive/resources/app`.
2. `npm run patch-exe` is only needed if the icon or version changed.
3. `npm run test:audio` measures the audio chain on a fake mic, in a hidden copy with its own settings. It takes about 3 minutes.

After changing Electron's version, run `npm run update-runtime` before these steps.

## Project layout
```
src/main/        Electron main process
  main.js          window, tray, start with Windows, app:// for the audio worklets
  migrate.js       moves settings and the login entry from when the app was called Mic Manager
  updates.js       asks GitHub whether a newer version exists
  preload.js       safe bridge between the window and main.js
  sysmic-client.js runs the Windows audio helper and talks to it
  win-audio.cs     Windows Core Audio helper: list mics, set volume and mute, report the ASUS mic key
  win-audio.ps1    runs that helper through PowerShell if win-audio.exe is missing
src/renderer/    the window
  index.html, styles.css, renderer.js
  voice-worklet.js noise reduction (RNNoise) and the voice gate
  gate-worklet.js  volume gate, for a gate set by hand or as the fallback
  nr-worklet.js    fallback noise reduction, if the voice engine can't start
  vendor/          RNNoise compiled to WebAssembly (@jitsi/rnnoise-wasm 0.2.1, Apache-2.0)
assets/          icons and mute sounds, both made from code (tools/make-icons.js, tools/make-sounds.js)
docs/            the screenshot above
tools/           build, packaging, signing, icon and sound scripts
  audio-test/      npm run test:audio
  installer/       the installer and uninstaller source, and npm run test:installer
```

The palette and icon are described in [DESIGN.md](DESIGN.md).
