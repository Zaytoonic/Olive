# Changelog

What changed in each release of Olive. Downloads are on the [Releases](https://github.com/Zaytoonic/Olive/releases) page.

## 2.2.1 (27 November 2026)

- Laughs come through: the voice gate stays open 600 ms after your last word (was 300 ms) and hears voice a little sooner, so the gaps inside a laugh no longer shut it. On two laugh recordings, 90% and 98% of the laughing got through (was 84% and 94%), and 83% and 89% of talking while laughing (was 69% and 86%). Mouse clicks still don't open it; typing alone holds it open a little more often (12% of the time, was 6%), and goes through the noise reduction.

## 2.2.0 (27 November 2026)

- The voice gate ignores your keyboard and mouse. A second voice detector, Silero VAD, checks RNNoise: the gate opens when Silero is sure it's your voice, or when RNNoise hears voice and Silero doesn't rule it out. On a room recording, typing alone held the gate open 42% of the time and clicks 29%; now 5% and 9%, and your voice still comes through while you type.
- Silero VAD (MIT) runs in plain JavaScript on the audio thread, no extra runtime: about 1 MB and under 2% of one CPU core.

## 2.1.0 (25 November 2026)

- One noise reduction: DeepFilterNet3 (2.0's HQ) for everyone; the HQ button and RNNoise as a cleaner are gone. Its gate now follows your voice (RNNoise only listens for it), so the pauses between words are silent: on a real room recording the noise between words went from -63 dB to silence, with the voice kept just as well (-0.5 dB).
- New installs start with the Clear voice EQ (low cut, less boom and mud, +4 dB presence) and the compressor on at 50%. Saved settings are kept.
- Lighter: Chromium's GPU and network helpers run inside Olive's main process (2 fewer processes, about 90 MB less memory), and 35 MB of unused graphics files are gone from the app. Voice detection only runs while the gate is on Auto, and noise reduction doesn't run while it's off.
- Choosing a mute hotkey that a soundboard key already uses says which sound has it (it blamed another app).

## 2.0.1 (25 November 2026)

- The notice when you close the window is headed "Olive" with Olive's icon (it said "electron.app.Olive"), and is one short line.

## 2.0.0 (25 November 2026)

- High quality noise reduction: the HQ button next to Noise reduction switches to DeepFilterNet3, which keeps your voice more natural, at about twice the CPU of the standard engine (about 1% of a typical PC). Its strength slider caps how much any sound is turned down, so a laugh can be ducked but not cut out.
- A cleaner window: sliders only show when they do something, High quality sits beside noise reduction, the Listen volume shows while Listen is on, and the text says only what you need.
- The soundboard's settings sit in two columns on a wide window.
- Lighter: Mono is on by default for new installs (stereo ran noise reduction twice, and Discord takes mono), the compressor no longer redraws the window while you talk, and noise reduction that was switched away no longer keeps running in the background.

## 1.8.1 (24 November 2026)

- Noise reduction goes back to RNNoise's April 2024 model. The 2025 model treated some laughs and parts of words as noise and cut them; the older one let 98.5% of normal talking through the gate on a laptop mic, against 62-88% before, and stays shut when you're quiet.
- It also removes more of a gusty fan's noise and uses about 30% less CPU.

## 1.8.0 (20 November 2026)

- A soundboard: add sound files (MP3, WAV, OGG, FLAC, M4A, up to 2 minutes), then play them to Discord on top of your voice with a click or a hotkey that works from anywhere, even in a game. A hotkey can be any key, even a single one like Num 1. Each sound has its own volume and name, and there's a Stop all button and hotkey.
- Sounds skip the noise reduction, gate and EQ, and a limiter stops them clipping. You can hear them yourself or not, and choose whether they play while you're muted.
- Olive keeps its own copy of each sound, so moving or deleting the original doesn't break it.
- Closing the window says where Olive went every time, not only the first time.

## 1.7.0 (11 November 2026)

- A rebuilt window, with new switches, sliders, dropdowns and buttons. Everything is where it was, and the settings still slide in from the right.
- The window uses the same CPU as before and about 15 MB more memory.
- After you plug in or remove a device, or press refresh, Olive keeps looking for your mic for a minute, as it already did at start-up.

## 1.6.4 (10 November 2026)

- Newer noise reduction: RNNoise's 2025 model, which picks out voices more reliably. It uses a bit more CPU.
- The noise gate waits for more confident voice detection, so steady noise no longer holds it open.
- In a maximised or full-screen window, the layout sits in the middle, with the scrollbar at the edge.
- The Muted badge is more see-through.

## 1.6.3 (8 November 2026)

- Settings you set once (mute hotkey, push to talk, mute sounds, the Muted badge, updates, start with Windows) moved behind a gear, in a panel that slides in from the right.
- A dot on the gear tells you when something there needs you: an update, a mute hotkey another app has taken, or push to talk not working.
- Tidier layout: a slimmer header, Microphone and Processing on the left, Output and monitoring on the right, and the noise gate's Auto switch in one row.

## 1.6.2 (6 November 2026)

- One-click updates: Settings → Updates → Install downloads the new version, checks it against GitHub's checksum, installs it and reopens Olive. If an install fails, the old version comes back and Olive says why.
- Mic test: records 5 seconds of what Discord would hear and plays it back to you only.
- An optional Muted badge in a corner of the screen while you're muted.
- Mute sounds can be turned off and have their own volume.
- Olive is now open source under the MIT licence.

## 1.6.1 (6 November 2026)

- New mute and unmute sounds made for Olive. Unmuting has its own sound.
- The hide-to-tray notice is clearer, shows only the first time, and opens Olive when clicked.

## 1.6.0 (5 November 2026)

- Mic Manager is now Olive.
- An installer and uninstaller, with no admin rights needed.
- Push to talk, a choice of output device for Listen and the mute sound, a check for new versions, and setup steps for VB-Cable on first start.
- The input meter shows your raw mic, with a chip saying whether the gate is open.
- New installs start with a flat EQ, and when there's no mic Olive says so instead of showing made-up ones.
- Fixed the audio slowing down after choosing an output device.

## Before 1.6

Olive was called Mic Manager up to 1.5.0. Those versions added RNNoise noise reduction, the voice-driven noise gate, the system-wide mute hotkey, per-mic EQ, support for the ASUS laptop mic key, and the move to Electron 45.
