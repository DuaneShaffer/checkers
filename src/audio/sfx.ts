export type SfxName = 'tap' | 'clack' | 'capture' | 'crown' | 'select' | 'illegal' | 'win' | 'lose';

type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let enabled = true;

function audioCtor(): Ctor | null {
  const w = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctx = audioCtor();
  if (!Ctx) return null;
  try {
    ctx = new Ctx();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

// Browsers (iOS Safari especially) only allow audio after a user gesture.
export function installAudioUnlock(target: EventTarget = window): () => void {
  const unlock = () => {
    const c = ensureContext();
    if (c && c.state === 'suspended') void c.resume();
  };
  const opts = { capture: true, passive: true } as const;
  target.addEventListener('pointerdown', unlock, opts);
  target.addEventListener('keydown', unlock, opts);
  return () => {
    target.removeEventListener('pointerdown', unlock, opts);
    target.removeEventListener('keydown', unlock, opts);
  };
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (master && ctx) master.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, 0.02);
}

export function playSfx(name: SfxName, opts: { pitch?: number } = {}): void {
  if (!enabled || !ctx || ctx.state !== 'running' || !master) return;
  const t = ctx.currentTime + 0.005;
  const pitch = opts.pitch ?? 1;
  switch (name) {
    case 'tap':
      woodKnock(t, 1900 * pitch, 0.55);
      break;
    case 'clack':
      woodKnock(t, 1200 * pitch, 0.8);
      break;
    case 'capture':
      woodKnock(t, 1200 * pitch, 0.8);
      woodKnock(t + 0.07, 1500 * pitch, 0.5);
      break;
    case 'crown':
      chime(t, [880, 1320], 1.1, 0.18);
      break;
    case 'select':
      tone(t, 'sine', 1600, 0.03, 0.12);
      break;
    case 'illegal':
      buzz(t);
      break;
    case 'win':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + i * 0.11, 'triangle', f, 0.35, 0.16));
      break;
    case 'lose':
      [392, 329.63].forEach((f, i) => tone(t + i * 0.2, 'triangle', f, 0.5, 0.15));
      break;
  }
}

function woodKnock(t: number, freq: number, gain: number): void {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noise;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = 5;
  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  src.connect(band).connect(env).connect(master!);
  src.start(t, Math.random() * 0.15, 0.08);
  tone(t, 'sine', 180 * (freq / 1900), 0.04, gain * 0.5);
}

function tone(t: number, type: OscillatorType, freq: number, dur: number, gain: number): void {
  const c = ctx!;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function chime(t: number, freqs: number[], dur: number, gain: number): void {
  const c = ctx!;
  const delay = c.createDelay(0.5);
  delay.delayTime.value = 0.13;
  const feedback = c.createGain();
  feedback.gain.value = 0.25;
  delay.connect(feedback).connect(delay);
  delay.connect(master!);
  for (const f of freqs) {
    for (const detune of [-3, 3]) {
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.detune.value = detune;
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(gain / 2, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(env);
      env.connect(master!);
      env.connect(delay);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
  setTimeout(() => {
    delay.disconnect();
    feedback.disconnect();
  }, (dur + 2) * 1000);
}

function buzz(t: number): void {
  const c = ctx!;
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 110;
  const low = c.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 600;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(low).connect(env).connect(master!);
  osc.start(t);
  osc.stop(t + 0.14);
}
