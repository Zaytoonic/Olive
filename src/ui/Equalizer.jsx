import { useEffect, useRef } from 'react';
import { Button, Switch } from '@heroui/react';
import * as S from './store.js';
import { useView as useV } from './store.js';
import { EQ_BANDS, PRESET_NAMES, bandDef, eq, fmtDb, fmtHz } from './eq-model.js';
import { mountEqGraph } from './eq-graph.js';
import { Hint, Icon, Pick, Toggle } from './bits.jsx';

const PRESETS = [...PRESET_NAMES.map(([id, name]) => ({ id, name })), { id: 'custom', name: 'Custom' }];

// The EQ opens like a dropdown: closed by default, and the choice is remembered. Closed, nothing in it can be changed by accident.
export function Equalizer() {
  const open = useV(v => v.st.eqOpen), forMic = useV(v => v.eqFor), notice = useV(v => v.eqNotice), preset = useV(v => v.eqPreset);
  useV(v => v.eqVersion);                        // re-render when the EQ changes (its on/off switch reads eq.on)
  return (
    <div className="olive-eq" data-off={!eq.on || undefined}>
      <div className="olive-eq-top">
        <button type="button" className="olive-eq-summary" aria-expanded={open} onClick={() => S.setEqOpen(!open)} title="Show or hide the EQ graph">
          <span className="olive-icon olive-chevron">{Icon.chevron}</span>
          <span className="olive-eq-title">
            <span className="olive-row-title">Mic EQ</span>
            <Hint>{forMic}</Hint>
            <Hint tone="notice">{notice}</Hint>
          </span>
        </button>
        <div className="olive-eq-head">
          <Pick label="EQ preset" items={preset === 'custom' ? PRESETS : PRESETS.slice(0, -1)} value={preset} onChange={S.choosePreset} title="Preset" className="olive-preset" />
          <Toggle label="Enable EQ" title="Enable EQ" isSelected={eq.on} onChange={S.setEqOn} />
        </div>
      </div>
      {open && <EqBody />}
    </div>
  );
}

function EqBody() {
  const canvas = useRef(null), body = useRef(null);
  const sel = useV(v => v.eqSel), bypass = useV(v => v.eqBypass), monitor = useV(v => v.st.monitor);
  useV(v => v.eqVersion);
  useEffect(() => {
    const g = mountEqGraph(canvas.current, { sel: () => S.getView().eqSel, select: S.selectBand, edited: S.eqEdited, editEnd: S.eqEditEnd });
    const detach = S.attachEqGraph(g);
    requestAnimationFrame(() => body.current && body.current.scrollIntoView({ block: 'nearest' }));
    return () => { detach(); g.destroy(); };
  }, []);
  const d = sel && bandDef(sel), s = sel && eq.b[sel];
  return (
    <div ref={body} className="olive-eq-body">
      <canvas ref={canvas} className="olive-eq-canvas" width="600" height="220" tabIndex={0} aria-label="EQ graph: drag points to shape your sound" />
      <div className="olive-eq-tools">
        <div className="olive-eq-chips" role="tablist" aria-label="EQ bands">
          {EQ_BANDS.map((b, i) => (
            <button key={b.key} type="button" role="tab" aria-selected={sel === b.key} title={b.name} className="olive-eq-chip"
              style={{ '--band': b.color }} onClick={() => S.selectBand(sel === b.key ? null : b.key)}>{i + 1}</button>
          ))}
        </div>
        <div className="olive-eq-readout" aria-live="polite">
          {!d ? 'Drag a point to shape your sound · Ctrl + scroll over it to change its width · double-click to reset' : (
            <>
              <b>{d.name}</b><span className="olive-value">{fmtHz(s.f)}</span><span className="olive-value">{fmtDb(s.g)}</span>
              {d.type === 'peaking' ? <span className="olive-value">Q {s.q.toFixed(2)}</span> : <span>shelf</span>}
              <Button size="sm" variant="ghost" onPress={S.resetSelectedBand}>Reset band</Button>
            </>
          )}
        </div>
      </div>
      <div className="olive-eq-bottom">
        <Switch isSelected={eq.lowCut} onChange={S.setLowCut} size="sm">
          <Switch.Content>
            <Switch.Control><Switch.Thumb /></Switch.Control>
            <span className="olive-lowcut">Low cut (80 Hz) · removes rumble and desk thumps</span>
          </Switch.Content>
        </Switch>
        <Button size="sm" variant={bypass ? 'primary' : 'secondary'} isDisabled={!(monitor && eq.on)}
          onPressStart={() => S.holdCompare(true)} onPressEnd={() => S.holdCompare(false)}>
          <span title="Turn on Listen, then hold this to hear yourself without the EQ. Discord keeps hearing the EQ.">{bypass ? 'Hearing without EQ' : 'Hold to compare'}</span>
        </Button>
      </div>
    </div>
  );
}
