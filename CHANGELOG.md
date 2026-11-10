# Changelog

What changed in each release of Olive. Downloads are on the [Releases](https://github.com/Zaytoonic/Olive/releases) page.

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
