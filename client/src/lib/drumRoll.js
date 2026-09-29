// A synthesized "drum roll into a crash" alert sound for new leads — built
// entirely from Web Audio API oscillators/noise, no external audio file.
// This app has no static-assets folder at all today (client/public doesn't
// exist), and synthesizing avoids any licensing question around a real
// recorded sample.

let ctx = null;
let masterBus = null;
let noiseBuffer = null;

function getContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// A shared compressor sits between every voice and the speakers so the
// crash hit (several overlapping bursts + a kick + a distorted stab) can't
// clip, instead of each node connecting straight to destination.
function getMasterBus(c) {
  if (!masterBus) {
    masterBus = c.createDynamicsCompressor();
    masterBus.threshold.value = -18;
    masterBus.ratio.value = 8;
    masterBus.connect(c.destination);
  }
  return masterBus;
}

// Browsers block audio until a real user gesture unlocks the AudioContext.
// Call this once from a page-level pointerdown/keydown listener so the
// context is already running by the time a real alert needs to play later.
export function unlockAudio() {
  const c = getContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function getNoiseBuffer(c) {
  if (noiseBuffer) return noiseBuffer;
  const length = c.sampleRate; // 1s of white noise, sliced per hit below
  noiseBuffer = c.createBuffer(1, length, c.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function noiseBurst(c, bus, { at, duration, freq, q = 1, gain = 0.6, type = 'bandpass' }) {
  const src = c.createBufferSource();
  src.buffer = getNoiseBuffer(c);
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = c.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.001, at + duration);
  src.connect(filter).connect(env).connect(bus);
  src.start(at);
  src.stop(at + duration + 0.02);
}

function kickThud(c, bus, at) {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(45, at + 0.25);
  const env = c.createGain();
  env.gain.setValueAtTime(0.9, at);
  env.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
  osc.connect(env).connect(bus);
  osc.start(at);
  osc.stop(at + 0.4);
}

function distortionCurve(amount) {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function powerChordStab(c, bus, at) {
  // Two low, distorted sawtooth notes a fifth apart under the crash — a
  // quick "heavy metal" stab, not a melody.
  [55, 82.4].forEach((freq) => {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const shaper = c.createWaveShaper();
    shaper.curve = distortionCurve(50);
    shaper.oversample = '4x';
    const lowpass = c.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1200;
    const env = c.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.3, at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    osc.connect(shaper).connect(lowpass).connect(env).connect(bus);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}

// Plays a short (~1.4s), rapid, accelerating snare-style noise roll that
// lands on one crash hit (a wide noise burst + a kick thud), layered with a
// quick distorted power-chord stab for a heavy-metal edge. Fails silently
// if Web Audio isn't available or the context is still locked — never
// blocks the toast/UI it accompanies.
export function playDrumRoll() {
  const c = getContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const bus = getMasterBus(c);

  const start = c.currentTime + 0.02;
  const hitCount = 14;
  let t = start;
  for (let i = 0; i < hitCount; i++) {
    const progress = i / (hitCount - 1);
    const gap = 0.09 - progress * 0.06; // 90ms -> 30ms, accelerating into the crash
    noiseBurst(c, bus, {
      at: t,
      duration: 0.05,
      freq: 300 + Math.random() * 2200,
      q: 2.5,
      gain: 0.35 + progress * 0.25,
    });
    t += gap;
  }

  noiseBurst(c, bus, { at: t, duration: 0.45, freq: 4000, q: 0.6, gain: 0.7, type: 'highpass' });
  kickThud(c, bus, t);
  powerChordStab(c, bus, t);
}
