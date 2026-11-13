// Keys that mute or talk: the laptop's mic key, the mute hotkey (also used by the tray), and push to talk.
import { state, ui, cleanErr } from './core.js';
import { savePrefs } from './prefs.js';
import { resetGateChip } from './meters.js';
import { updateSendStatus } from './cable.js';
import {
  toggleMute, setAllMuted, playMuteSound, syncTalking,
  sysApi, curSys, storeSys, applySysToUi, touchSys, live, sysStatus, sysEndpoints
} from './store.js';

// ---- The laptop's mic key ----
// ASUS's own software answers the key by flipping mute on the Windows default recording device. So wait for that to land,
// then follow it. If nothing flipped (that software isn't running), an odd number of presses is a toggle.
// Everything compares with the state before the first press: the background check can notice ASUS's change and mute
// the app first, and comparing with the state at that point would read as "nothing flipped" and undo the mute.
export const micKeyResult = (before, presses, defaultMuted) =>
  (defaultMuted !== null && defaultMuted !== before ? defaultMuted : presses % 2 ? !before : before);
let micKeyPresses = 0, micKeyTimer = null, micKeyBefore = false;
export function onMicKey() {
  if (micKeyPresses === 0) micKeyBefore = state.muted;
  micKeyPresses++;
  touchSys();                                          // hold off the background check while this settles
  clearTimeout(micKeyTimer);
  micKeyTimer = setTimeout(settleMicKey, 250);
}
async function settleMicKey() {
  const presses = micKeyPresses, before = micKeyBefore;
  micKeyPresses = 0;
  let def = null;
  if (sysApi && live && sysStatus === 'ready') {
    try { const list = await sysApi.list(); list.forEach(e => storeSys(e)); sysEndpoints.forEach(e => { const n = list.find(x => x.id === e.id); if (n) e.isDefault = n.isDefault; }); def = list.find(e => e.isDefault); } catch { /* use what we know */ }
  }
  const m = micKeyResult(before, presses, def ? def.muted : null);
  setAllMuted(m);
  if (m !== before) playMuteSound(m);
}

// ---- Mute hotkey and tray ----
// window.appMute comes from preload.js. The window may have been hidden for a while, so ask Windows for the
// current mute state first: otherwise the toggle could go the wrong way after something else changed it.
async function toggleMuteFromOutside() {
  const ep = curSys();
  if (ep) { try { storeSys(await sysApi.get(ep.id)); applySysToUi(); } catch { /* toggle from what we know */ } }
  toggleMute();
}
export const hotkeyLabel = a => a.replace('Control', 'Ctrl').replace('Super', 'Win');
export async function applyMuteHotkey() {
  const label = hotkeyLabel(state.muteAccel);
  if (!state.muteHotkey) { await window.appMute.setHotkey(null); ui({ muteKeyHint: 'Off: Ctrl+M still works while this window has focus' }); return; }
  const ok = await window.appMute.setHotkey(state.muteAccel);
  ui({ muteKeyHint: ok ? `${label} mutes your mic from anywhere` : `${label} is already in use by another app` });
}
export function setMuteHotkeyOn(on) { state.muteHotkey = on; applyMuteHotkey(); savePrefs(); ui(); }
// Changing the shortcut: the next key combination pressed in this window becomes it.
// The old one is released while choosing, otherwise pressing it again would never reach this window.
export let hotkeyChoosing = false;
function hotkeyFromEvent(e) {
  const letter = /^Key([A-Z])$/.exec(e.code), digit = /^Digit(\d)$/.exec(e.code), fn = /^F(?:[1-9]|1\d|2[0-4])$/.test(e.code);
  const key = letter ? letter[1] : digit ? digit[1] : fn ? e.code : null;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!fn && !mods.some(m => m !== 'Shift')) return null;   // a plain letter would stop typing it anywhere
  return [...mods, key].join('+');
}
function setHotkeyChoosing(on) { hotkeyChoosing = on; ui({ hotkeyChoosing: on }); }
export async function startChoosingHotkey() {
  if (hotkeyChoosing || !window.appMute) return;
  setHotkeyChoosing(true);
  await window.appMute.setHotkey(null);
  ui({ muteKeyHint: 'Press the new shortcut, or Esc to cancel' });
}
async function finishChoosingHotkey(accelerator) {
  setHotkeyChoosing(false);
  if (!accelerator) return applyMuteHotkey();
  if (await window.appMute.setHotkey(accelerator)) {
    state.muteAccel = accelerator;
    savePrefs();
    return applyMuteHotkey();
  }
  await applyMuteHotkey();
  ui({ muteKeyHint: `${hotkeyLabel(accelerator)} is already in use by another app. Keeping ${hotkeyLabel(state.muteAccel)}` });
}
window.addEventListener('keydown', e => {
  if (!hotkeyChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingHotkey(null); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // still holding modifiers
  const accelerator = hotkeyFromEvent(e);
  if (accelerator) finishChoosingHotkey(accelerator);
  else ui({ muteKeyHint: 'Use Ctrl, Alt or Win with a letter or number, or an F key. Esc cancels' });
}, true);
window.addEventListener('blur', () => { if (hotkeyChoosing) finishChoosingHotkey(null); });
export function initMuteHotkey() {
  if (!window.appMute) { ui({ muteKeyAvailable: false, muteKeyHint: 'Only in the Windows app' }); return; }
  window.appMute.onToggle(toggleMuteFromOutside);
  window.appMute.onMicKey(onMicKey);
  applyMuteHotkey();
}

// ---- Push to talk ----
// Silences what leaves Olive (the cable and Listen) unless the key is held. It doesn't touch Windows mute: that takes too long to follow a key.
const PTT_TAIL_MS = 200;                       // keeps the end of the last word after the key comes up
export let pttOpen = false, pttChoosing = false;
let pttTail = null;
export const talking = () => !state.muted && (!state.ptt || pttOpen);
export const talkFade = () => (state.ptt && pttOpen ? 0.005 : 0.02);
function setPttOpen(open) { pttOpen = open; syncTalking(); updateSendStatus(); }
function onPttKey(down) {
  clearTimeout(pttTail);
  if (down) setPttOpen(true);
  else pttTail = setTimeout(() => setPttOpen(false), PTT_TAIL_MS);
}
function vkFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return { vk: m[1].charCodeAt(0), label: m[1] };
  if ((m = /^Digit(\d)$/.exec(code))) return { vk: 0x30 + +m[1], label: m[1] };
  if ((m = /^F(\d+)$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return { vk: 0x6f + +m[1], label: code };
  if ((m = /^Numpad(\d)$/.exec(code))) return { vk: 0x60 + +m[1], label: 'Numpad ' + m[1] };
  const named = { Space: [0x20, 'Space'], CapsLock: [0x14, 'Caps Lock'], Tab: [0x09, 'Tab'], Backquote: [0xc0, '`'], ShiftLeft: [0xa0, 'Left Shift'], ShiftRight: [0xa1, 'Right Shift'],
    ControlLeft: [0xa2, 'Left Ctrl'], ControlRight: [0xa3, 'Right Ctrl'], AltLeft: [0xa4, 'Left Alt'], AltRight: [0xa5, 'Right Alt'], Insert: [0x2d, 'Insert'], Pause: [0x13, 'Pause'], ScrollLock: [0x91, 'Scroll Lock'] };
  return named[code] ? { vk: named[code][0], label: named[code][1] } : null;
}
function showPttHint() {
  let h;
  if (!state.ptt) h = 'Off: your mic is open unless you mute it';
  else if (!state.pttKey) h = 'Choose a key to hold while you talk';
  else if (!state.send) h = `Hold ${state.pttKey.label} to talk. Turn on Send to Discord too: apps using your mic directly aren't affected`;
  else h = /^[A-Z0-9]$/.test(state.pttKey.label) ? `Hold ${state.pttKey.label} to talk. It still types ${state.pttKey.label} in other apps` : `Hold ${state.pttKey.label} to talk`;
  ui({ pttHint: h, pttNotice: false });
}
export async function applyPtt() {
  clearTimeout(pttTail);
  setPttOpen(false);
  showPttHint();
  resetGateChip();
  if (!window.appPtt) return;
  try {
    await window.appPtt.set(state.ptt && state.pttKey ? state.pttKey.vk : 0);
  } catch (err) {
    // Fails closed: staying silent is safer than an open mic you think is off.
    ui({ pttHint: "Couldn't watch the key, so your mic stays silent. Turn this off to talk: " + cleanErr(err), pttNotice: true });
  }
}
export function setPtt(on) {
  state.ptt = on;
  if (on && !state.pttKey) startChoosingPtt();
  applyPtt(); savePrefs(); ui();
}
function finishChoosingPtt(key) {
  pttChoosing = false;
  ui({ pttChoosing: false });
  if (key) { state.pttKey = key; savePrefs(); }
  applyPtt();
}
export function startChoosingPtt() {
  if (pttChoosing) return;
  pttChoosing = true;
  ui({ pttChoosing: true, pttHint: 'Press a key or a side mouse button, or Esc to cancel', pttNotice: false });
}
window.addEventListener('keydown', e => {
  if (!pttChoosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosingPtt(null); return; }
  const key = vkFromCode(e.code);
  if (key) finishChoosingPtt(key);
  else ui({ pttHint: "That key can't be used. Try a letter, an F key, Space, or a side mouse button. Esc cancels" });
}, true);
window.addEventListener('pointerdown', e => {
  if (!pttChoosing) return;
  const key = { 1: { vk: 0x04, label: 'Middle mouse' }, 3: { vk: 0x05, label: 'Mouse 4' }, 4: { vk: 0x06, label: 'Mouse 5' } }[e.button];
  if (!key) return;
  e.preventDefault(); e.stopImmediatePropagation();
  finishChoosingPtt(key);
}, true);
window.addEventListener('blur', () => { if (pttChoosing) finishChoosingPtt(null); });
export function initPtt() {
  if (!window.appPtt) { ui({ pttAvailable: false, pttHint: 'Only in the Windows app' }); return; }
  window.appPtt.onKey(onPttKey);
  applyPtt();
}
