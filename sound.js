// Sounds of the table, synthesised with Web Audio: no files to download.
// On iPhone the ring/silent switch mutes them; the speaker button on the page turns them off completely.

const KEY = "table-sound";
let ctx = null, noise = null, master = null;
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== "off"; } catch { /* storage may be blocked */ }

function audio() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// Browsers start audio only after a touch on the page itself.
export function unlock() { audio(); }

export function isOn() { return enabled; }

export function setOn(on) {
  enabled = on;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* ignore */ }
  if (on) audio();
}

function burst({ dur, freq, q = 1, gain = 0.2, sweepTo = null, rate = 1 }) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = rate;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

function tone(freq, { at = 0, dur = 1.2, gain = 0.05, type = "sine" } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const sound = {
  flick: () => burst({ dur: 0.045, freq: 2600 + Math.random() * 1400, q: 0.9, gain: 0.16, rate: 1.4 }),
  tick: () => tone(2100 + Math.random() * 300, { dur: 0.04, gain: 0.025 }),
  land: () => { burst({ dur: 0.09, freq: 900, q: 0.7, gain: 0.12 }); tone(1318.5, { dur: 0.5, gain: 0.02 }); },
  whoosh: () => burst({ dur: 0.42, freq: 380, sweepTo: 2400, q: 0.8, gain: 0.1 }),
  chime(big = false) {
    const notes = big ? [261.63, 392.0, 523.25, 783.99, 1046.5, 1567.98] : [659.25, 987.77, 1318.51];
    notes.forEach((n, i) => tone(n, { at: i * (big ? 0.07 : 0.05), dur: big ? 2.4 : 1.3, gain: big ? 0.045 : 0.03 }));
  },
  rise() {
    [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1318.51, 1567.98].forEach((n, i) =>
      tone(n, { at: i * 0.075, dur: 1.4, gain: 0.035, type: i % 2 ? "sine" : "triangle" }));
    burst({ dur: 1.1, freq: 600, sweepTo: 6000, q: 0.6, gain: 0.05 });
  },
};
