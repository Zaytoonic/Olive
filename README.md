# Mic Manager

Microphone manager for Windows, inspired by SteelSeries Sonar's mic tab.

**Run it:** `dist\MicManager\MicManager.exe` (keep it in its folder; closing hides it to the tray).

## Folders
```
src/main/        Electron main process: window, tray, start-with-Windows, Windows mic control
  main.js          app window, tray, app:// (serves the noise-gate worklet)
  preload.js       safe bridge between the window and main.js
  sysmic-client.js runs win-audio.ps1 and talks to it
  win-audio.ps1    Windows Core Audio: list mics, set volume / mute
src/renderer/    the window
  index.html, styles.css, renderer.js
  gate-worklet.js  noise gate that runs on the audio thread
assets/          icon.png, icon.ico, tray-icon.png
tools/           build.js, patch-exe.js
dist/MicManager/ the built app (MicManager.exe + Electron runtime)
```

## After changing the code
1. `npm install` (once)
2. `npm run build` copies `src` and `assets` into `dist/MicManager/resources/app`
3. `npm run patch-exe` (only if the icon or version changed; close the app first)

Or run from source with `npm start`.
