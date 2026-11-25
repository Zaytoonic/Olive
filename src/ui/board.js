// ---- Soundboard ----
// Your sounds: Olive keeps a copy of each file (main/soundboard.js) and the list here, in your saved settings.
// The engine plays them into what Discord hears (with Send on) and, if you like, on your own output.
import { engine, state, ui, cleanErr } from './core.js';
import { savePrefs, scheduleSave } from './prefs.js';

export const BOARD_MAX_SECONDS = 120;   // decoded, a clip takes ~23 MB a minute; soundboard sounds are short
const api = () => window.appBoard;
const failed = new Set();               // clips whose copy couldn't be read or decoded at start-up
const idOf = file => file.split('.')[0];

// For prefs.js
export function loadBoardPrefs(p) {
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  state.board = Array.isArray(p.board)
    ? p.board.filter(c => c && typeof c.file === 'string' && typeof c.name === 'string').slice(0, 200)
        .map(c => ({ id: idOf(c.file), file: c.file, name: c.name.slice(0, 60), vol: num(c.vol, 0, 100, 100), key: typeof c.key === 'string' && c.key ? c.key : null }))
    : [];
  state.boardVol = num(p.boardVol, 0, 100, state.boardVol);
  state.boardLocalVol = num(p.boardLocalVol, 0, 100, state.boardLocalVol);
  if (typeof p.boardLocal === 'boolean') state.boardLocal = p.boardLocal;
  if (typeof p.boardWhileMuted === 'boolean') state.boardWhileMuted = p.boardWhileMuted;
  state.boardStopKey = typeof p.boardStopKey === 'string' && p.boardStopKey ? p.boardStopKey : null;
}
export const boardPrefs = () => ({
  board: state.board.map(({ file, name, vol, key }) => ({ file, name, vol, key })),
  boardVol: state.boardVol, boardLocal: state.boardLocal, boardLocalVol: state.boardLocalVol, boardWhileMuted: state.boardWhileMuted,
  boardStopKey: state.boardStopKey
});
export const boardEngineCfg = () => ({
  boardVol: state.boardVol / 100, boardLocal: state.boardLocal, boardLocalVol: state.boardLocalVol / 100, boardWhileMuted: state.boardWhileMuted
});

function show(extra = {}) { ui({ boardPlaying: engine.clipsPlaying(), boardFailed: [...failed], ...extra }); }
export const boardChanged = () => show();      // the engine says a clip started or ended
const hint = (boardHint, boardHintTone = '') => show({ boardHint, boardHintTone });

// Reads Olive's copy and decodes it. Resolves with its length in seconds; throws if it can't be used.
async function loadClip(clip) {
  const data = await api().read(clip.file);
  return engine.loadClip(clip.id, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

export async function initBoard() {
  show();
  if (!api()) return;
  api().onKey(id => (id === 'stop' ? stopSounds() : playSound(id)));
  applyBoardKeys();
  for (const clip of state.board) {
    try { await loadClip(clip); failed.delete(clip.id); } catch { failed.add(clip.id); }
  }
  show();
}

// What main/soundboard.js copied in: decoded and checked here, kept or thrown away.
async function addCopies({ added, skipped }) {
  const kept = [], skip = [...skipped];
  for (const { file, name, original = name } of added) {
    const clip = { id: idOf(file), file, name: name.slice(0, 60), vol: 100 };
    let seconds = 0;
    try { seconds = await loadClip(clip); } catch { skip.push({ name: original, why: "couldn't be played (not a sound Chromium can decode)" }); api().remove(file); continue; }
    if (seconds > BOARD_MAX_SECONDS) { engine.unloadClip(clip.id); api().remove(file); skip.push({ name: original, why: `longer than ${BOARD_MAX_SECONDS / 60} minutes` }); continue; }
    kept.push(clip);
  }
  if (kept.length) { state.board = [...state.board, ...kept]; savePrefs(); }
  const parts = [];
  if (kept.length) parts.push(`Added ${kept.length} sound${kept.length > 1 ? 's' : ''}.`);
  if (skip.length) parts.push('Skipped ' + skip.map(s => `${s.name}: ${s.why}`).join('; ') + '.');
  hint(parts.join(' '), skip.length ? 'warn' : 'on');
}
export async function addSounds() {
  if (!api()) return;
  try { await addCopies(await api().pick()); } catch (err) { hint("Couldn't add sounds: " + cleanErr(err), 'warn'); }
}
export async function dropSounds(files) {
  if (!api() || !files || !files.length) return;
  const paths = Array.from(files, f => api().pathOf(f));
  if (!paths.some(Boolean)) { hint("Couldn't add those: drop files from a folder on your PC.", 'warn'); return; }
  try { await addCopies(await api().importPaths(paths.filter(Boolean))); } catch (err) { hint("Couldn't add sounds: " + cleanErr(err), 'warn'); }
}

export function playSound(id) {
  const clip = state.board.find(c => c.id === id);
  if (!clip) return;
  if (failed.has(id)) { hint(`"${clip.name}" couldn't be loaded. Remove it and add the file again.`, 'warn'); return; }
  if (!engine.playClip(id, clip.vol / 100)) hint("Couldn't play it: Olive's audio isn't running yet.", 'warn');
  else if (!state.send && !state.boardLocal) hint('Nobody hears it: Send and "Hear them yourself" are off', 'warn');
  else hint('');
}
export const stopSounds = () => engine.stopClips();
export function renameSound(id, name) {
  state.board = state.board.map(c => (c.id === id ? { ...c, name: name.slice(0, 60) } : c));
  show(); scheduleSave();
}
export function setSoundVol(id, vol) {
  state.board = state.board.map(c => (c.id === id ? { ...c, vol } : c));
  show(); scheduleSave();
}
export function removeSound(id) {
  const clip = state.board.find(c => c.id === id);
  if (!clip) return;
  engine.unloadClip(id);
  failed.delete(id);
  state.board = state.board.filter(c => c.id !== id);
  if (api()) api().remove(clip.file).catch(() => {});
  savePrefs();
  show({ boardSel: null });
  if (clip.key) applyBoardKeys();
}
export const selectSound = id => show({ boardSel: id });

export function setBoardVol(v) { state.boardVol = v; engine.set(boardEngineCfg()); show(); scheduleSave(); }
export function setBoardLocal(on) { state.boardLocal = on; engine.set(boardEngineCfg()); show(); savePrefs(); }
export function setBoardLocalVol(v) { state.boardLocalVol = v; engine.set(boardEngineCfg()); show(); scheduleSave(); }
export function setBoardWhileMuted(on) { state.boardWhileMuted = on; engine.set(boardEngineCfg()); show(); savePrefs(); }

// ---- Hotkeys: one per sound, and one for Stop all ----
// They work from anywhere, like the mute hotkey (main.js registers them). Any key works, alone or with Ctrl, Alt, Shift
// or Win: it's your choice. A key alone that other apps type with (a letter, a number) is taken from them while it's set,
// and the window says so. Choosing one: the next key (or combination) pressed in this window becomes it. All of them are released while choosing, so pressing one that's taken reaches
// this window and can be refused here instead of playing its sound.
let choosing = null;                     // a sound's id, or 'stop'
export async function applyBoardKeys() {
  if (!api() || !api().setKeys) return;
  const list = choosing ? [] : [...state.board.filter(c => c.key).map(c => [c.key, c.id]), ...(state.boardStopKey ? [[state.boardStopKey, 'stop']] : [])];
  let res = {};
  try { res = await api().setKeys(list); } catch { /* treated as not registered */ }
  show({ boardKeyFailed: list.filter(([a]) => !res[a]).map(([a]) => a) });
}
// KeyboardEvent.code -> the key's name in an Electron accelerator (main.js checks the same list)
const KEY_NAMES = {
  Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3', Numpad4: 'num4', Numpad5: 'num5', Numpad6: 'num6', Numpad7: 'num7',
  Numpad8: 'num8', Numpad9: 'num9', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Enter: 'Enter',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
};
function boardKeyFromEvent(e) {
  const letter = /^Key([A-Z])$/.exec(e.code), digit = /^Digit(\d)$/.exec(e.code), fn = /^F(?:[1-9]|1\d|2[0-4])$/.test(e.code);
  const key = letter ? letter[1] : digit ? digit[1] : fn ? e.code : KEY_NAMES[e.code];
  if (!key) return null;
  return [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
}
const NICE = { num: 'Num ', numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .', Up: '↑', Down: '↓', Left: '←', Right: '→' };
export const boardKeyLabel = acc => acc.split('+').map(k => (k === 'Control' ? 'Ctrl' : k === 'Super' ? 'Win' : NICE[k] || (/^num\d$/.test(k) ? 'Num ' + k.slice(3) : k))).join('+');
// A key alone that other apps type or play with: while it's a hotkey, they don't get it.
export const takesTypingKey = acc => !!acc && !acc.includes('+') && !/^(F\d+|num.*|Insert|Delete|Home|End|PageUp|PageDown)$/.test(acc);
const keyOwner = acc => (acc === 'Control+M' ? 'Ctrl+M (mute, in this window)' : state.muteHotkey && state.muteAccel === acc ? 'the mute hotkey'
  : state.boardStopKey === acc ? 'Stop all'
  : (c => (c ? `"${c.name}"` : null))(state.board.find(c => c.key === acc)));
// For the mute hotkey's chooser (keys.js): which of the soundboard's keys this is, if any.
export const soundboardKeyOwner = acc => (state.boardStopKey === acc ? 'Stop all' : (c => (c ? `"${c.name}"` : null))(state.board.find(c => c.key === acc)));
function setKey(target, acc) {
  if (target === 'stop') state.boardStopKey = acc;
  else state.board = state.board.map(c => (c.id === target ? { ...c, key: acc } : c));
}
export function startChoosingBoardKey(target) {
  if (choosing || !api()) return;
  choosing = target;
  show({ boardChoosing: target, boardKeyFor: target, boardKeyHint: 'Press a key · Esc cancels' });
  applyBoardKeys();
}
function finishChoosing(acc) {
  const target = choosing;
  choosing = null;
  let msg = '';
  if (acc) {
    const owner = keyOwner(acc);
    if (owner && !(target === 'stop' ? state.boardStopKey === acc : (state.board.find(c => c.id === target) || {}).key === acc)) msg = `${boardKeyLabel(acc)} is already used by ${owner}`;
    else { setKey(target, acc); savePrefs(); }
  }
  show({ boardChoosing: null, boardKeyFor: target, boardKeyHint: msg });
  applyBoardKeys();
}
export function clearBoardKey(target) { setKey(target, null); savePrefs(); show({ boardKeyHint: '' }); applyBoardKeys(); }
window.addEventListener('keydown', e => {
  if (!choosing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { finishChoosing(null); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // still holding modifiers
  const acc = boardKeyFromEvent(e);
  if (acc) finishChoosing(acc);
  else show({ boardKeyHint: "Can't use that key · Esc cancels" });
}, true);
window.addEventListener('blur', () => { if (choosing) finishChoosing(null); });
