// ---- Mic EQ ----
// Each mic keeps its own EQ, stored by name. A mic seen for the first time starts from the EQ in use.
// The bands themselves live in eq-model.js and the graph in eq-graph.js; this is what the window does with them.
import { EQ_PRESETS, eq, resetBand, restoreEq, snapshotEq, applyPreset } from './eq-model.js';
import { engine, state, view, ui } from './core.js';
import { savePrefs, scheduleSave } from './prefs.js';

const eqByMic = {};
let eqOwner = null, eqPresetPref = 'flat', eqGraph = null;
export function attachEqGraph(g) { eqGraph = g; return () => { if (eqGraph === g) eqGraph = null; }; }
export function redrawEqGraph() { if (eqGraph) eqGraph.draw(); }
export const presetShown = () => (EQ_PRESETS[eqPresetPref] ? eqPresetPref : 'custom');
// Another mic was chosen or found: keep the old one's EQ and bring back the new one's.
export function switchEqTo(name) {
  if (!name) return;
  ui({ eqFor: 'Saved for ' + name });
  if (name === eqOwner) return;
  if (eqOwner) eqByMic[eqOwner] = snapshotEq(view.eqPreset);
  eqOwner = name;
  if (eqByMic[name]) { eqPresetPref = restoreEq(eqByMic[name]); ui({ eqPreset: presetShown() }); applyEq(); }
}
export function applyEq() {
  engine.set({ eq });
  redrawEqGraph();
  ui({ eqVersion: view.eqVersion + 1 });
}
// For prefs.js: restore the EQ from saved settings (the chosen mic's own, if it has one), and what to save.
export function loadEqPrefs(p, deviceName) {
  if (p.eqByMic && typeof p.eqByMic === 'object') Object.assign(eqByMic, p.eqByMic);
  const startEq = (deviceName && eqByMic[deviceName]) || p.eq;
  if (startEq && typeof startEq === 'object') eqPresetPref = restoreEq(startEq);
  eqOwner = deviceName;
}
export const eqPrefs = () => ({
  eq: snapshotEq(view.eqPreset),
  eqByMic: eqOwner ? { ...eqByMic, [eqOwner]: snapshotEq(view.eqPreset) } : eqByMic
});
// The graph changed a band (dragging, keys, scroll): it's no longer a preset.
export function eqEdited() { if (view.eqPreset !== 'custom') ui({ eqPreset: 'custom' }); eqPresetPref = 'custom'; applyEq(); scheduleSave(); }
export const eqEditEnd = () => savePrefs();
export function selectBand(key) { ui({ eqSel: key }); redrawEqGraph(); }
export function resetSelectedBand() { if (view.eqSel) { resetBand(view.eqSel); eqEdited(); savePrefs(); } }
export function choosePreset(key) {
  const p = EQ_PRESETS[key]; if (!p) return;
  applyPreset(p); eqPresetPref = key; ui({ eqPreset: key }); applyEq(); savePrefs();
}
export function setEqOn(on) { eq.on = on; applyEq(); savePrefs(); }
export function setLowCut(on) { eq.lowCut = on; eqPresetPref = 'custom'; ui({ eqPreset: 'custom' }); applyEq(); savePrefs(); }
export function setEqOpen(open) {
  state.eqOpen = open === true;
  if (!state.eqOpen) ui({ eqSel: null }); else ui();
  savePrefs();
}
// Hold to compare: what you hear skips the EQ; what's sent keeps it.
export function holdCompare(on) { if (view.eqBypass === on) return; engine.set({ eqBypass: on }); ui({ eqBypass: on }); }

// For test-bridge.js.
export const eqTestHooks = {
  restoreEq: src => { eqPresetPref = restoreEq(src); },
  showEqPreset: () => ui({ eqPreset: presetShown() }),
  eqPoint: key => (eqGraph ? eqGraph.point(key) : null)
};
