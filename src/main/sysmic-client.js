// Runs the Windows audio helper (win-audio.exe, or win-audio.ps1 as the fallback) and talks to it over stdin/stdout.
// One request per line "id<TAB>cmd<TAB>args...", one JSON reply per line.
const { spawn } = require('child_process');

class HelperClient {
  constructor(command, args, { timeoutMs = 15000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.seq = 0;
    this.buf = '';
    this.stderr = '';
    this.dead = false;
    this.deathReason = '';
    try {
      this.proc = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this._die('could not start helper: ' + err.message);
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.on('error', err => this._die('helper error: ' + err.message));
    this.proc.on('exit', code => this._die(`helper exited (code ${code})` + (this.stderr.trim() ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' ') : '')));
    this.proc.stdin.on('error', () => {});   // broken pipe is reported through 'exit'
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event) { if (this.onEvent) this.onEvent(msg.event); continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'helper error'));
    }
  }

  _die(reason) {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  call(cmd, ...args) {
    if (this.dead) return Promise.reject(new Error(this.deathReason || 'helper not running'));
    const parts = [cmd, ...args].map(String);
    if (parts.some(p => /[\t\r\n]/.test(p))) return Promise.reject(new Error('invalid argument'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('helper timed out')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write([id, ...parts].join('\t') + '\n');
    });
  }

  stop() {
    if (this.proc && !this.dead) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} }
    this._die('helper stopped');
  }
}

module.exports = { HelperClient };
