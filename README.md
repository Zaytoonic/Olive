# Olive

Olive is a microphone manager for Windows, inspired by SteelSeries Sonar's mic tab.

**Run it:** `dist\Olive\Olive.exe` (keep it in its folder; closing hides it to the tray).

The design notes are in [DESIGN.md](DESIGN.md).

## Folders
```
src/main/        Electron main process: window, tray, start-with-Windows, Windows mic control
  main.js          app window, tray, app:// (serves the three audio worklets and RNNoise)
  preload.js       safe bridge between the window and main.js
  migrate.js       moves settings and the login entry from when the app was called Mic Manager
  sysmic-client.js runs win-audio.exe (win-audio.ps1 is the fallback) and talks to it
  win-audio.cs     Windows Core Audio helper: list mics, set volume / mute; reports the ASUS mic key
  win-audio.ps1    runs that helper through PowerShell if win-audio.exe (built from it, not in git) is missing
src/renderer/    the window
  index.html, styles.css, renderer.js
  gate-worklet.js  volume gate: used when the gate is set by hand, or as the fallback
  voice-worklet.js noise reduction (RNNoise) with a strength blend, and the gate that opens on detected voice
  vendor/          RNNoise compiled to WebAssembly (@jitsi/rnnoise-wasm 0.2.1, Apache-2.0, see its license file)
  nr-worklet.js    fallback noise reduction, if the voice engine can't start
assets/          olive-icon-1024.png, icon.png, icon.ico, tray icons, muted variants (all drawn by tools/make-icons.js), mute-sound.mp3
tools/           build.js, build-helper.js, make-icons.js, patch-exe.js, update-runtime.js, audio-test/ (npm run test:audio)
dist/Olive/      the built app (Olive.exe + Electron runtime)
```

## After changing the code
1. `npm install` (once)
2. `npm run build` copies `src` and `assets` into `dist/Olive/resources/app`
3. `npm run patch-exe` (only if the icon or version changed; close the app first)
   After changing Electron's version, run `npm run update-runtime` before these steps.
4. `npm run test:audio` after audio changes: measures the chain on a fake mic in a hidden, muted copy (about 3 minutes; your running app and settings aren't touched)

Or run from source with `npm start`.
