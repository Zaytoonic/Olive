import { Button, Drawer } from '@heroui/react';
import * as S from './store.js';
import { useView as useV } from './store.js';
import { Level, Pick, Row, Toggle } from './bits.jsx';

const CORNERS = [
  { id: 'top-left', name: 'Top left' }, { id: 'top-center', name: 'Top middle' }, { id: 'top-right', name: 'Top right' },
  { id: 'bottom-left', name: 'Bottom left' }, { id: 'bottom-right', name: 'Bottom right' }
];

// Things you set once live behind the gear. The drawer keeps focus inside while it's open; Esc or a click outside closes it.
export function Settings() {
  const open = useV(v => v.settingsOpen), version = useV(v => v.appVersion);
  return (
    <Drawer.Backdrop isOpen={open} onOpenChange={S.setSettingsOpen} className="olive-backdrop">
      <Drawer.Content placement="right" className="olive-drawer">
        <Drawer.Dialog className="olive-drawer-dialog">
          <Drawer.CloseTrigger aria-label="Close settings" />
          <Drawer.Header><Drawer.Heading>Settings</Drawer.Heading></Drawer.Header>
          <Drawer.Body className="olive-drawer-body">
            <h3 className="olive-section-title">Mute &amp; talk</h3>
            <div className="olive-group"><MuteHotkey /><PushToTalk /><MuteSounds /><Badge /></div>
            <h3 className="olive-section-title">App</h3>
            <div className="olive-group"><Updates /><Startup /></div>
            <p className="olive-about"><span id="appVersion">{version}</span> · MIT licence</p>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function MuteHotkey() {
  const on = useV(v => v.st.muteHotkey), hint = useV(v => v.muteKeyHint), choosing = useV(v => v.hotkeyChoosing), available = useV(v => v.muteKeyAvailable);
  return (
    <Row title="Mute hotkey" hint={hint} hintId="muteKeyHint" hintTone={/in use/.test(hint) ? 'warn' : undefined}
      end={<>
        <Button id="muteKeyChange" size="sm" variant={choosing ? 'primary' : 'secondary'} isDisabled={!available || !on} onPress={S.startChoosingHotkey}>
          <span title="Choose a different shortcut">{choosing ? 'Press keys…' : 'Change'}</span>
        </Button>
        <Toggle label="Mute hotkey" title="Toggle mute with this shortcut, even when this window is hidden" isSelected={available && on} isDisabled={!available} onChange={S.setMuteHotkeyOn} />
      </>} />
  );
}

function PushToTalk() {
  const on = useV(v => v.st.ptt), key = useV(v => v.st.pttKey), hint = useV(v => v.pttHint), notice = useV(v => v.pttNotice);
  const choosing = useV(v => v.pttChoosing), available = useV(v => v.pttAvailable);
  return (
    <Row title="Push to talk" hint={hint} hintId="pttHint" hintTone={notice ? 'warn' : undefined}
      end={<>
        <Button id="pttChange" size="sm" variant={choosing ? 'primary' : 'secondary'} isDisabled={!available} onPress={S.startChoosingPtt}>
          <span title="Choose the key or mouse button to hold">{choosing ? 'Press a key…' : key ? 'Change key' : 'Choose key'}</span>
        </Button>
        <Toggle label="Push to talk" title="Only send your voice while a key is held" isSelected={on} isDisabled={!available} onChange={S.setPtt} />
      </>} />
  );
}

function MuteSounds() {
  const on = useV(v => v.st.muteSounds), vol = useV(v => v.st.muteSoundVol), hint = useV(v => v.soundHint);
  return (
    <Row title="Mute sounds" value={on ? vol + '%' : 'Off'} valueId="soundVal" hint={hint}
      end={<Toggle label="Mute sounds" title="Play a short sound when you mute or unmute" isSelected={on} onChange={S.setMuteSounds} />}>
      <Level label="Mute sound volume" value={vol} min={5} max={100} onChange={S.setMuteSoundVol} onChangeEnd={S.previewMuteSound} isDisabled={!on} />
    </Row>
  );
}

function Badge() {
  const on = useV(v => v.st.badge), corner = useV(v => v.st.badgeCorner), hint = useV(v => v.badgeHint), available = useV(v => v.badgeAvailable);
  return (
    <Row title="Muted badge on screen" hint={hint}
      end={<Toggle label="Muted badge on screen" title="Show a small Muted badge over other apps while you're muted" isSelected={available && on} isDisabled={!available} onChange={S.setBadge} />}>
      <Pick label="Badge position" items={CORNERS} value={corner} onChange={S.setBadgeCorner} isDisabled={!available || !on} title="Where the badge appears" className="olive-badge-corner" />
    </Row>
  );
}

function Updates() {
  const auto = useV(v => v.st.updateAuto), hint = useV(v => v.updateHint), label = useV(v => v.updateBtnLabel);
  const disabled = useV(v => v.updateBtnDisabled), notes = useV(v => v.updateNotesShown), available = useV(v => !!v.updateAvailable);
  return (
    <Row title="Updates" hint={hint} hintId="updateHint" hintTone={available ? 'on' : undefined}
      end={<>
        <Button id="updateNotes" size="sm" variant="ghost" onPress={S.openReleaseNotes} hidden={!notes}>What's new</Button>
        <Button id="updateBtn" size="sm" variant={available ? 'primary' : 'secondary'} isDisabled={disabled} onPress={S.pressUpdate}>{label}</Button>
        <Toggle label="Check for updates automatically" title="Check for new versions automatically" isSelected={auto} onChange={S.setUpdateAuto} />
      </>} />
  );
}

function Startup() {
  const on = useV(v => v.startupOn), hint = useV(v => v.startupHint), disabled = useV(v => v.startupDisabled);
  return (
    <Row title="Start with Windows" hint={hint} hintId="startupHint"
      end={<Toggle label="Start with Windows" title="Launch Olive when you log in" isSelected={on} isDisabled={disabled} onChange={S.setStartup} />} />
  );
}

