import { useEffect, useRef } from 'react';
import { Button, Card, ToggleButton } from '@heroui/react';
import * as S from './store.js';
import { useView as useV } from './store.js';
import { Hint, Icon, Level, Pick, Row, Toggle, Value } from './bits.jsx';
import { Equalizer } from './Equalizer.jsx';
import { Settings } from './Settings.jsx';

export function App() {
  return (
    <div className="olive-app">
      <Header />
      <main className="olive-main">
        <div className="olive-column">
          <SetupCard />
          <MicCard />
          <div className="olive-columns">
            <div className="olive-col">
              <Section title="Microphone"><Volume /><Gate /></Section>
              <Section title="Processing"><NoiseReduction /><Compressor /></Section>
            </div>
            <div className="olive-col">
              <Section title="Output"><Send /><Mono /><Monitoring /><OutputDevice /></Section>
            </div>
          </div>
          <Section title="Equalizer"><Equalizer /></Section>
        </div>
      </main>
      <Settings />
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="olive-section">
      <h3 className="olive-section-title">{title}</h3>
      <Card className="olive-card" variant="default"><Card.Content className="olive-card-body">{children}</Card.Content></Card>
    </section>
  );
}

function Header() {
  const reasons = useV(v => S.settingsReasons(v).join('; ')), open = useV(v => v.settingsOpen), gear = useRef(null);
  const title = reasons ? 'Settings: ' + reasons : 'Settings';
  useEffect(() => { if (gear.current) gear.current.title = title; }, [title]);   // HeroUI's Button doesn't pass title on
  return (
    <header className="olive-toolbar">
      <img className="olive-logo" src="../../assets/icon.png" alt="" width="26" height="26" />
      <h1>Olive</h1>
      <Button ref={gear} id="settingsBtn" isIconOnly variant="ghost" className="olive-gear" aria-label="Settings" aria-haspopup="dialog" aria-expanded={open}
        onPress={() => S.setSettingsOpen(true)}>
        <span className="olive-icon">{Icon.gear}</span>
        <span id="settingsDot" className="olive-dot" aria-hidden="true" hidden={!reasons} />
      </Button>
    </header>
  );
}

function SetupCard() {
  const shown = useV(v => v.setupCardShown), cable = useV(v => v.setupCable), download = useV(v => v.setupDownloadShown);
  return (
    <Card id="setupCard" className="olive-card olive-setup" hidden={!shown}>
      <Card.Header><Card.Title>Set up Olive for Discord</Card.Title></Card.Header>
      <Card.Content>
        <ol className="olive-steps">
          <li>
            <span>Install VB-Audio Virtual Cable: it's how Olive's sound reaches other apps. Restart your PC afterwards.</span>
            <Hint id="setupCable">{cable}</Hint>
            <Button id="setupDownload" size="sm" variant="secondary" onPress={S.setupDownload} hidden={!download}>Open the download page</Button>
          </li>
          <li><span>In Discord, go to <b>User Settings &gt; Voice &amp; Video</b> and set the input device to <b>CABLE Output</b>.</span></li>
        </ol>
      </Card.Content>
      <Card.Footer className="olive-setup-actions">
        <Button size="sm" variant="secondary" onPress={S.setupCheck}>Check again</Button>
        <Button id="setupDone" size="sm" onPress={S.setupFinished}>Done</Button>
      </Card.Footer>
    </Card>
  );
}

function MicCard() {
  const muted = useV(v => v.st.muted), monitor = useV(v => v.st.monitor);
  const devices = useV(v => v.devices), deviceId = useV(v => v.st.deviceId), micDisabled = useV(v => v.micDisabled), placeholder = useV(v => v.micPlaceholder);
  const micNotice = useV(v => v.micNotice), devStatus = useV(v => v.devStatus), appNotice = useV(v => v.appNotice), testHint = useV(v => v.testHint);
  const testLabel = useV(v => v.testLabel), testPhase = useV(v => v.testPhase), testDisabled = useV(v => v.testDisabled), muteTitle = useV(v => v.muteTitle);
  return (
    <Card className="olive-card olive-hero" data-muted={muted || undefined}>
      <Card.Content className="olive-hero-body">
        <div className="olive-current">
          <div className="olive-current-text">
            <span className="olive-caption" id="micLabel">Selected microphone</span>
            <div className="olive-mic-pick">
              <Pick label="Selected microphone" items={devices} value={devices.some(d => d.id === deviceId) ? deviceId : null}
                onChange={S.selectDevice} isDisabled={micDisabled} placeholder={placeholder} title="Choose a microphone" className="olive-mic-select" />
              <Button id="refreshBtn" isIconOnly variant="ghost" size="sm" aria-label="Refresh the microphone list" onPress={() => S.loadDevices()}>
                <span className="olive-icon" title="Refresh the microphone list">{Icon.refresh}</span>
              </Button>
            </div>
            <Hint id="micNotice" tone="notice">{micNotice}</Hint>
            <Hint id="devStatus">{devStatus}</Hint>
            <Hint id="appNotice" tone="notice">{appNotice}</Hint>
            <Hint id="testHint" live>{testHint}</Hint>
          </div>
          <div className="olive-actions">
            <Button id="testBtn" variant="secondary" isDisabled={testDisabled} onPress={S.pressTest} className="olive-pill" data-phase={testPhase || undefined}>
              <span title="Record 5 seconds, then hear exactly what Olive sends to Discord">{testLabel}</span>
            </Button>
            <ToggleButton id="listenBtn" isSelected={monitor} onChange={S.setMonitor} className="olive-pill olive-listen" aria-label="Listen">
              <span title="Hear your mic live (use headphones)">{monitor ? 'Listening' : 'Listen'}</span>
            </ToggleButton>
            <Button id="muteBtn" variant={muted ? 'danger' : 'secondary'} onPress={S.toggleMute} aria-pressed={muted} className="olive-pill olive-mute">
              <span className="olive-icon small">{muted ? Icon.micOff : Icon.mic}</span><span title={muteTitle}>{muted ? 'Muted' : 'Mute'}</span>
            </Button>
          </div>
        </div>
        {muted && (
          <div className="olive-muted-banner" role="status">
            <span className="olive-icon small">{Icon.micOff}</span><span>Muted. Nobody can hear you.</span>
          </div>
        )}
        <InputMeter />
      </Card.Content>
    </Card>
  );
}

// The meter's moving parts are written by the store's timer (no React renders while it moves).
function InputMeter() {
  const cover = useRef(null), peak = useRef(null), levelDb = useRef(null), chip = useRef(null);
  const muted = useV(v => v.st.muted), markHidden = useV(v => v.gateMarkHidden), markPct = useV(v => v.gateMarkPct);
  useEffect(() => S.setMeterEls({ cover: cover.current, peak: peak.current, levelDb: levelDb.current, chip: chip.current }), []);
  return (
    <div className="olive-meter-block">
      <div className="olive-row-head">
        <span className="olive-meter-title">
          <span className="olive-caption">Input level</span>
          <span ref={chip} id="gateChip" className="olive-gate-chip" data-state="none" title="Whether your sound is getting through to other apps" />
        </span>
        <span ref={levelDb} id="levelDb" className="olive-value">-∞ dB</span>
      </div>
      <div className="olive-meter" data-muted={muted || undefined}>
        <div className="olive-meter-fill" />
        <div ref={cover} className="olive-meter-cover" />
        <div ref={peak} className="olive-meter-peak" />
        {!markHidden && <div className="olive-gate-mark" style={{ left: markPct + '%' }} title="Noise gate threshold" />}
      </div>
      <div className="olive-scale"><span>-60</span><span>-40</span><span>-20</span><span>-10</span><span>0 dB</span></div>
    </div>
  );
}

function Volume() {
  const volume = useV(v => v.st.volume), hint = useV(v => v.volumeHint), hintTitle = useV(v => v.volumeHintTitle), title = useV(v => v.volumeTitle);
  return (
    <div title={title || undefined}>
      <Row title="Volume" value={volume + '%'}>
        <Level label="Volume" value={volume} onChange={S.setVolume} />
        <Hint title={hintTitle}>{hint}</Hint>
      </Row>
    </div>
  );
}

function Gate() {
  const auto = useV(v => v.st.gateAuto), db = useV(v => v.st.gateDb), label = useV(v => v.gateVal), hint = useV(v => v.gateHint);
  return (
    <Row title="Noise gate" value={label} hint={hint}
      end={<ToggleButton size="sm" isSelected={auto} onChange={S.setGateAuto} className="olive-chip-toggle" aria-label="Automatic noise gate">
        <span title="Auto: the gate follows your voice and background noise. Off: set the level by hand with the slider">Auto</span>
      </ToggleButton>}>
      <Level label="Noise gate level" value={db} min={-60} max={-10} onChange={S.setGateDb} isDisabled={auto} />
    </Row>
  );
}

function NoiseReduction() {
  const on = useV(v => v.st.nr), amount = useV(v => v.st.nrAmount), hint = useV(v => v.nrHint);
  return (
    <Row title="Noise reduction" value={on ? amount + '%' : 'Off'} hint={hint}
      end={<Toggle label="Noise reduction" title="Automatic noise reduction" isSelected={on} onChange={S.setNr} />}>
      <Level label="Noise reduction strength" value={amount} onChange={S.setNrAmount} isDisabled={!on} />
    </Row>
  );
}

function Compressor() {
  const on = useV(v => v.st.comp), amount = useV(v => v.st.compAmount), hint = useV(v => v.compHint);
  return (
    <Row title="Compressor / auto-level" value={on ? amount + '%' : 'Off'} hint={hint}
      end={<Toggle label="Compressor" title="Even out your volume" isSelected={on} onChange={S.setComp} />}>
      <Level label="Compressor strength" value={amount} onChange={S.setCompAmount} isDisabled={!on} />
    </Row>
  );
}

function Send() {
  const on = useV(v => v.sendOn), hint = useV(v => v.sendHint), cls = useV(v => v.sendHintCls), title = useV(v => v.sendTitle);
  const levelShown = useV(v => v.sendLevelShown), setupOpen = useV(v => v.setupOpenShown);
  return (
    <Row title="Send to Discord / other apps"
      end={<Toggle label="Send to Discord / other apps" title={title} isSelected={on} onChange={S.setSendWanted} />}>
      <Hint id="sendHint" tone={cls === 'warn' ? 'warn' : cls === 'on' ? 'on' : undefined} title={title}>{hint}</Hint>
      <div hidden={!setupOpen}><Button id="setupOpen" size="sm" variant="secondary" onPress={S.setupShow}>Show setup steps</Button></div>
      <SendLevel shown={levelShown} />
    </Row>
  );
}
// The send level bar's moving parts, handed to the meter timer like the input meter's.
function SendLevel({ shown }) {
  const cover = useRef(null), db = useRef(null);
  useEffect(() => (shown ? S.setMeterEls({ sendCover: cover.current, sendDb: db.current }) : undefined), [shown]);
  if (!shown) return null;
  return (
    <div className="olive-send-level">
      <div className="olive-mini-meter" title="The level other apps receive"><div className="olive-mini-fill" /><div ref={cover} className="olive-mini-cover" /></div>
      <span ref={db} className="olive-value">-∞ dB</span>
    </div>
  );
}

function Mono() {
  const on = useV(v => v.st.mono), hint = useV(v => v.monoHint);
  return <Row title="Mono audio" hint={hint} end={<Toggle label="Mono audio" title="Mix left and right into one channel" isSelected={on} onChange={S.setMono} />} />;
}

function Monitoring() {
  const on = useV(v => v.st.monitor), vol = useV(v => v.st.monitorVol), hint = useV(v => v.monHint);
  return (
    <Row title="Mic monitoring" value={on ? vol + '%' : 'Off'} hint={hint}
      end={<Toggle label="Mic monitoring" title="Hear yourself" isSelected={on} onChange={S.setMonitor} />}>
      <Level label="Monitoring level" value={vol} onChange={S.setMonitorVol} isDisabled={!on} />
    </Row>
  );
}

function OutputDevice() {
  const outputs = useV(v => v.outputs), sel = useV(v => v.outputSelected), hint = useV(v => v.outputHint);
  return (
    <Row title="Listen and mute sounds play on" hint={hint} hintTone="notice" hintId="outputHint">
      <Pick label="Listen and mute sounds play on" items={outputs} value={sel} onChange={S.chooseOutput} className="olive-output-select"
        title="Where you hear yourself and the mute sounds. Discord doesn't hear either." />
    </Row>
  );
}
