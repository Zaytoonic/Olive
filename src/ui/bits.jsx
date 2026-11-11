// Small building blocks on top of HeroUI, so every row in Olive looks and behaves the same.
import { Label, ListBox, Select, Slider, Switch } from '@heroui/react';
import { savePrefs } from './store.js';

// Always rendered (an empty hint is hidden by CSS), so its text can be read and announced when it appears.
export const Hint = ({ children, tone, title, live, id }) =>
  <p id={id} className="olive-hint" data-tone={tone || undefined} title={title || undefined} aria-live={live ? 'polite' : undefined}>{children}</p>;

export const Value = ({ children, id }) => <span id={id} className="olive-value">{children}</span>;

// HeroUI's components don't pass a title on to the page, so hover text goes on a wrapper.
export function Toggle({ label, isSelected, onChange, isDisabled, title }) {
  return (
    <span className="olive-tip" title={title}>
      <Switch aria-label={label} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} size="md">
        <Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch.Content>
      </Switch>
    </span>
  );
}

export function Level({ label, value, onChange, onChangeEnd, min = 0, max = 100, isDisabled }) {
  const end = v => { savePrefs(); if (onChangeEnd) onChangeEnd(+v); };   // let go of a slider: saved at once
  return (
    <Slider aria-label={label} value={value} onChange={v => onChange(+v)} onChangeEnd={end}
      minValue={min} maxValue={max} isDisabled={isDisabled} className="olive-slider">
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}

// A row: title (and its hint) on the left, controls on the right, anything else (a slider) below.
export function Row({ title, hint, hintTone, hintId, value, valueId, end, children, htmlFor }) {
  return (
    <div className="olive-row">
      <div className="olive-row-head">
        <div className="olive-row-text">
          {htmlFor ? <Label htmlFor={htmlFor} className="olive-row-title">{title}</Label> : <span className="olive-row-title">{title}</span>}
        </div>
        <div className="olive-row-end">
          {value != null && <Value id={valueId}>{value}</Value>}
          {end}
        </div>
      </div>
      {children}
      <Hint tone={hintTone} id={hintId}>{hint}</Hint>
    </div>
  );
}

// A dropdown from a list of { id, name }.
export function Pick({ label, items, value, onChange, isDisabled, placeholder, title, className }) {
  return (
    <div className={'olive-pick ' + (className || '')} title={title}>
    <Select aria-label={label} value={value ?? null} onChange={k => k != null && onChange(String(k))} isDisabled={isDisabled}
      placeholder={placeholder} variant="secondary" fullWidth>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="olive-popover">
        <ListBox>
          {items.map(it => (
            <ListBox.Item key={it.id} id={it.id} textValue={it.name}>
              {it.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
    </div>
  );
}

export const Icon = {
  gear: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  refresh: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><polyline points="16.5 3.5 16.5 6.5 13.5 6.5"/></svg>,
  mic: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5z"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5v3"/></svg>,
  micOff: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5z"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5v3"/><line x1="3" y1="3" x2="17" y2="17"/></svg>,
  headphones: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 13v-2.5a6.5 6.5 0 0 1 13 0V13"/><rect x="2.5" y="12" width="3.5" height="5" rx="1.2"/><rect x="14" y="12" width="3.5" height="5" rx="1.2"/></svg>,
  play: <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" className="fill"/></svg>,
  chevron: <svg viewBox="0 0 20 20" aria-hidden="true"><polyline points="7.5 4.5 13 10 7.5 15.5"/></svg>
};
