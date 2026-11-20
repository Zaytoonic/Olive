import { useState } from 'react';
import { Button, Input } from '@heroui/react';
import * as S from './store.js';
import { useView as useV } from './store.js';
import { Hint, Icon, Level, Row, Toggle } from './bits.jsx';

// Sounds you can play to Discord on top of your voice. Files can be dropped anywhere on this card.
export function Soundboard() {
  const board = useV(v => v.st.board), playing = useV(v => v.boardPlaying), sel = useV(v => v.boardSel);
  const hint = useV(v => v.boardHint), tone = useV(v => v.boardHintTone), sendOn = useV(v => v.sendOn), local = useV(v => v.st.boardLocal);
  const [dragging, setDragging] = useState(false);
  const status = sendOn ? 'Click a sound to play it. Discord hears it over your voice.'
    : local ? 'Send to Discord is off, so only you hear these.' : "Send to Discord is off, and you've turned off hearing them, so nobody hears these.";
  const hasFiles = e => Array.from(e.dataTransfer.types || []).includes('Files');
  const selected = board.find(c => c.id === sel);
  return (
    <>
      <div id="boardDrop" className="olive-board" data-dragging={dragging || undefined}
        onDragOver={e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={e => { e.preventDefault(); setDragging(false); S.dropSounds(e.dataTransfer.files); }}>
        <div className="olive-row-head">
          <div className="olive-row-text">
            <span className="olive-row-title">Sounds</span>
            <Hint tone={sendOn ? undefined : 'notice'}>{status}</Hint>
          </div>
          <div className="olive-row-end">
            <Button id="boardStop" size="sm" variant="secondary" onPress={S.stopSounds} isDisabled={!playing.length}>Stop all</Button>
            <Button id="boardAdd" size="sm" onPress={S.addSounds}>Add sounds</Button>
          </div>
        </div>
        {board.length
          ? <div className="olive-pads">{board.map(c => <Pad key={c.id} clip={c} playing={playing.includes(c.id)} editing={c.id === sel} />)}</div>
          : <div className="olive-board-empty">Drag sound files here, or click Add sounds.<br />MP3, WAV, OGG, FLAC or M4A, up to {S.BOARD_MAX_SECONDS / 60} minutes long.</div>}
        <Hint id="boardHint" tone={tone || undefined} live>{hint}</Hint>
        {selected && <PadEditor clip={selected} />}
      </div>
      <BoardLevels />
    </>
  );
}

function Pad({ clip, playing, editing }) {
  const failed = useV(v => v.boardFailed.includes(clip.id));
  return (
    <div className="olive-pad" data-playing={playing || undefined} data-failed={failed || undefined} data-editing={editing || undefined}>
      <button type="button" className="olive-pad-play" onClick={() => S.playSound(clip.id)}
        title={failed ? "This sound couldn't be loaded. Remove it and add it again" : playing ? 'Playing. Click to start again' : 'Click to play'}>
        <span className="olive-pad-name">{clip.name || 'Untitled'}</span>
        {(clip.vol !== 100 || clip.key) && <span className="olive-pad-vol">{[clip.key && S.boardKeyLabel(clip.key), clip.vol !== 100 && clip.vol + '%'].filter(Boolean).join(' · ')}</span>}
      </button>
      <button type="button" className="olive-pad-edit" aria-label={'Edit ' + clip.name} aria-pressed={editing}
        title="Edit: name, volume, hotkey" onClick={() => S.selectSound(editing ? null : clip.id)}>
        <span className="olive-icon small">{Icon.dots}</span>
      </button>
    </div>
  );
}

function PadEditor({ clip }) {
  return (
    <div className="olive-pad-editor" aria-label={'Edit ' + clip.name}>
      <div className="olive-row-head">
        <Input id="boardName" aria-label="Sound name" value={clip.name} maxLength={60} onChange={e => S.renameSound(clip.id, e.target.value)}
          onBlur={() => S.savePrefs()} className="olive-pad-input" />
        <div className="olive-row-end">
          <Button id="boardRemove" size="sm" variant="danger" onPress={() => S.removeSound(clip.id)}>Remove</Button>
          <Button size="sm" variant="secondary" onPress={() => S.selectSound(null)}>Done</Button>
        </div>
      </div>
      <Row title="Volume" value={clip.vol + '%'}>
        <Level label="This sound's volume" value={clip.vol} onChange={v => S.setSoundVol(clip.id, v)} />
      </Row>
      <KeyRow title="Hotkey" target={clip.id} accel={clip.key} what="play this sound" />
    </div>
  );
}

function BoardLevels() {
  const vol = useV(v => v.st.boardVol), local = useV(v => v.st.boardLocal), localVol = useV(v => v.st.boardLocalVol), muted = useV(v => v.st.boardWhileMuted);
  return (
    <>
      <Row title="Volume for others" value={vol + '%'} hint="How loud others hear your sounds">
        <Level label="Soundboard volume for others" value={vol} onChange={S.setBoardVol} />
      </Row>
      <Row title="Hear sounds yourself" value={local ? localVol + '%' : 'Off'}
        hint={local ? 'You hear your sounds too' : 'Only others hear your sounds'}
        end={<Toggle label="Hear sounds yourself" title="Play sounds on your own output too" isSelected={local} onChange={S.setBoardLocal} />}>
        <Level label="Soundboard volume for you" value={localVol} onChange={S.setBoardLocalVol} isDisabled={!local} />
      </Row>
      <KeyRow title="Stop all hotkey" target="stop" accel={useV(v => v.st.boardStopKey)} what="stop all sounds" />
      <Row title="Play while muted" hint={muted ? "Sounds play even when you're muted" : 'Muting also mutes your sounds'}
        end={<Toggle label="Play sounds while muted" title="Let sounds through while your mic is muted" isSelected={muted} onChange={S.setBoardWhileMuted} />} />
    </>
  );
}

// A hotkey: what it is, Set/Change (the next key, or combination, pressed becomes it) and Remove.
function KeyRow({ title, target, accel, what }) {
  const choosing = useV(v => v.boardChoosing === target), failed = useV(v => !!accel && v.boardKeyFailed.includes(accel));
  const hint = useV(v => (v.boardKeyFor === target ? v.boardKeyHint : ''));   // "press the shortcut", or why one was refused
  const label = accel ? S.boardKeyLabel(accel) : 'None';
  const idle = !accel ? `Click Set key, then press the key you want to ${what}.`
    : `Press ${label} anywhere, even in a game, to ${what}.` + (S.takesTypingKey(accel) ? ` Other apps can't use ${label} while it's set.` : '');
  return (
    <Row title={title} value={choosing ? 'Press a key…' : label}
      hint={choosing || hint ? hint : failed ? `Another app is already using ${label}. Pick a different key.` : idle}
      hintTone={failed || (!choosing && hint) ? 'warn' : undefined}
      end={<>
        {accel && !choosing && <Button size="sm" variant="ghost" onPress={() => S.clearBoardKey(target)}>Remove</Button>}
        <Button size="sm" variant={choosing ? 'primary' : 'secondary'} onPress={() => S.startChoosingBoardKey(target)}>{choosing ? 'Waiting…' : accel ? 'Change' : 'Set key'}</Button>
      </>} />
  );
}
