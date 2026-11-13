// ---- Send to other apps (VB-Audio Virtual Cable), and the first-run setup that checks it's installed ----
import { engine, state, ui } from './core.js';
import { savePrefs } from './prefs.js';
import { pttOpen } from './keys.js';
import { live, loadDevices } from './store.js';

export const isCableLabel = l => /\bCABLE\b.*VB-Audio|VB-Audio Virtual Cable/i.test(l || '');
let sendToken = 0;
export function sendHint(text, cls) {
  ui({
    sendHint: text, sendHintCls: cls || '',
    sendTitle: cls === 'on' ? 'Sending to the virtual cable. In Discord, choose "CABLE Output (VB-Audio Virtual Cable)" as your input device.' : 'Send the processed mic to VB-Audio Virtual Cable'
  });
}
// What other apps get right now, in words. The level bar only shows while the cable is connected.
export function updateSendStatus() {
  const connected = engine.hasSend && state.send && live;
  ui({ sendLevelShown: connected });
  if (!connected) return;
  if (state.muted) sendHint('Muted: nothing is being sent', 'on');
  else if (state.ptt && !pttOpen) sendHint(state.pttKey ? `Push to talk: hold ${state.pttKey.label} to send` : 'Push to talk: choose a key below', 'on');
  else sendHint('Sending. In Discord, choose "CABLE Output" as your input', 'on');
}
let findCable = async function findCable() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return outs.find(d => /CABLE Input/i.test(d.label)) || outs.find(d => isCableLabel(d.label)) || null;
};
function stopSending() { state.send = false; engine.set({ send: false }); engine.closeSend(); ui({ sendOn: false }); }
export async function setSend(on) {
  const token = ++sendToken;
  if (!on) {
    stopSending();
    sendHint('Off: other apps hear your raw mic');
    updateSendStatus();
    return;
  }
  ui({ sendOn: true });
  try {
    const cable = await findCable();
    if (token !== sendToken) return;
    if (!cable) {
      stopSending();
      sendHint('VB-Audio Virtual Cable not found. Install it from vb-audio.com/Cable, restart the PC, then try again.', 'warn');
      updateSendStatus();
      return;
    }
    if (!engine.sendingTo(cable.deviceId)) {
      sendHint('Connecting…');
      state.send = false; engine.set({ send: false });
      if (!(await engine.openSend(cable.deviceId)) || token !== sendToken) return;
    }
    state.send = true;
    engine.set({ send: true });
    if (live) updateSendStatus(); else sendHint('On · but there is no microphone to send', 'warn');
    ui();
  } catch (err) {
    if (token !== sendToken) return;
    stopSending();
    sendHint("Couldn't send to the virtual cable (" + (err.name || 'Error') + ': ' + err.message + ')', 'warn');
    updateSendStatus();
  }
}

// ---- First-run setup ----
let freshInstall = false;
// start() says whether there were saved settings; without them, the setup card stays up even if the cable is found.
export function setFreshInstall(v) { freshInstall = v; }
export async function updateSetup() {
  let found = false;
  try { found = !!(await findCable()); } catch { /* treated as not found */ }
  if (found && !freshInstall && !state.setupDone) { state.setupDone = true; savePrefs(); }
  ui({ setupCable: found ? 'Found: the virtual cable is installed.' : 'Not found yet.', setupDownloadShown: !found, setupCardShown: !state.setupDone, setupOpenShown: !found && state.setupDone });
}
export const setupDownload = () => { if (window.appInfo) window.appInfo.open('vbcable'); };
export const setupCheck = () => loadDevices();
export function setupFinished() { state.setupDone = true; savePrefs(); updateSetup(); }
export function setupShow() { state.setupDone = false; freshInstall = true; updateSetup(); }

// For test-bridge.js.
export const cableTestVars = {
  freshInstall: [() => freshInstall, v => { freshInstall = v; }],
  findCable: [() => findCable, v => { findCable = v; }]
};
