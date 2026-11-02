# Mic Manager

Microphone manager for Windows, inspired by SteelSeries Sonar's mic tab.

**Run it:** `dist\MicManager\MicManager.exe` (keep it in its folder; closing hides it to the tray).

The look can be switched between Glass and Classic in the app; see [DESIGN.md](DESIGN.md).

## Folders
```
src/main/        Electron main process: window, tray, start-with-Windows, Windows mic control
  main.js          app window, tray, app:// (serves the noise-gate worklet)
  preload.js       safe bridge between the window and main.js
  sysmic-client.js runs win-audio.ps1 and talks to it
  win-audio.cs     Windows Core Audio helper: list mics, set volume / mute; reports the ASUS mic key
  win-audio.ps1    runs that helper through PowerShell if win-audio.exe (built from it, not in git) is missing
src/renderer/    the window
  index.html, styles.css, theme-glass.css, renderer.js
  gate-worklet.js  volume gate: used when the gate is set by hand, or as the fallback
  voice-worklet.js noise reduction (RNNoise) with a strength blend, and the gate that opens on detected voice
  vendor/          RNNoise compiled to WebAssembly (@jitsi/rnnoise-wasm 0.2.1, Apache-2.0, see its license file)
  nr-worklet.js    fallback noise reduction, if the voice engine can't start
assets/          icon.png, icon.ico, tray-icon.png, tray-icon-muted.png, taskbar-muted-badge.png
tools/           build.js, build-helper.js, patch-exe.js, audio-test/ (npm run test:audio)
dist/MicManager/ the built app (MicManager.exe + Electron runtime)
```

## After changing the code
1. `npm install` (once)
2. `npm run build` copies `src` and `assets` into `dist/MicManager/resources/app`
3. `npm run patch-exe` (only if the icon or version changed; close the app first)
4. `npm run test:audio` after audio changes: measures the chain on a fake mic in a hidden, muted copy (about 3 minutes; your running app and settings aren't touched)

Or run from source with `npm start`.
