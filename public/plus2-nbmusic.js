// plus2-nbmusic.js — trilha do tema "Noite de Lançamento" (v0.99.1).
//
// Só toca com esse tema aplicado (quem liga/desliga é o plus2-interact.js).
// Por padrão é uma trilha synthwave ORIGINAL gerada ao vivo pelo navegador
// (Web Audio: bateria, baixo, acordes e arpejo com eco) — sem arquivo e sem
// direito autoral de terceiros. Se existir /assets/music/noite-de-lancamento.mp3
// (uma faixa que você tenha direito de usar), ela toca no lugar.
(function (global) {
  'use strict';
  const FILE = '/assets/music/noite-de-lancamento.mp3';
  let ctx = null, master = null, comp = null, delay = null, verb = null, noiseBuf = null;
  let playing = false, schedT = 0, step = 0, nextTime = 0, fileAudio = null, fileChecked = null;
  const BPM = 104, SPB = 60 / BPM, S16 = SPB / 4;
  const beatListeners = [];

  // Am – F – C – G (um compasso cada, 8 compassos = 2 voltas com variação)
  const CHORDS = [
    { root: 45, notes: [57, 60, 64, 69] }, // Lá menor
    { root: 41, notes: [57, 60, 65, 69] }, // Fá maior
    { root: 48, notes: [55, 60, 64, 67] }, // Dó maior
    { root: 43, notes: [55, 59, 62, 67] }, // Sol maior
  ];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function setup() {
    if (ctx) return true;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0;
    master.connect(comp).connect(ctx.destination);
    // eco (3/16) pro arpejo
    delay = ctx.createDelay(1); delay.delayTime.value = S16 * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2600;
    delay.connect(dl).connect(fb).connect(delay);
    const dOut = ctx.createGain(); dOut.gain.value = 0.5; delay.connect(dOut).connect(master);
    // reverb simples (resposta gerada)
    verb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.2, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    verb.buffer = ir;
    const vOut = ctx.createGain(); vOut.gain.value = 0.32; verb.connect(vOut).connect(master);
    // ruído pra caixa e chimbal
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return true;
  }
  function env(g, t, a, peak, dec, sus) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sus), t + a + dec);
  }
  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.34);
    const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
    setTimeout(() => beatListeners.forEach((f) => { try { f(); } catch (_) { /* ok */ } }), delayMs);
  }
  function noise(t, dur, type, freq, vol, toVerb) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(master); if (toVerb) g.connect(verb);
    s.start(t); s.stop(t + dur + 0.02);
  }
  function snare(t) {
    noise(t, 0.22, 'bandpass', 1800, 0.45, true);
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); o.connect(g).connect(master); o.start(t); o.stop(t + 0.14);
  }
  function hat(t, open) { noise(t, open ? 0.16 : 0.04, 'highpass', 8000, open ? 0.12 : 0.08, false); }
  function bass(t, midi, dur) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = hz(midi);
    f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(260, t + dur); f.Q.value = 6;
    env(g, t, 0.005, 0.28, dur * 0.9, 0.0001);
    o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function pad(t, notes, dur) {
    notes.forEach((m) => {
      [-7, 7].forEach((det) => {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = hz(m - 12); o.detune.value = det;
        f.type = 'lowpass'; f.frequency.value = 1300;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.022, t + 0.35); g.gain.setValueAtTime(0.022, t + dur - 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(f).connect(g); g.connect(master); g.connect(verb);
        o.start(t); o.stop(t + dur + 0.05);
      });
    });
  }
  function arp(t, midi) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = hz(midi);
    f.type = 'lowpass'; f.frequency.value = 2400;
    env(g, t, 0.004, 0.07, S16 * 1.6, 0.0001);
    o.connect(f).connect(g); g.connect(master); g.connect(delay);
    o.start(t); o.stop(t + S16 * 2);
  }
  function schedule(i, t) {
    const bar = Math.floor(i / 16) % 8, s = i % 16, ch = CHORDS[bar % 4], intro = Math.floor(i / 16) < 2;
    if (s === 0) pad(t, ch.notes, SPB * 4);
    if (!intro || s % 8 === 0) { if (s % 4 === 0) kick(t); }
    if (!intro && (s === 4 || s === 12)) snare(t);
    if (!intro && s % 2 === 0) hat(t, s % 8 === 6);
    if (s % 2 === 0) bass(t, ch.root - (s % 4 === 2 ? 0 : 12) + 12, S16 * 1.8);
    if (bar >= 1) { const seq = [0, 1, 2, 3, 2, 1, 0, 1]; arp(t, ch.notes[seq[s % 8]] + 12 + (bar % 8 >= 4 && s % 4 === 3 ? 12 : 0)); }
  }
  function tick() {
    while (nextTime < ctx.currentTime + 0.12) { schedule(step, nextTime); step++; nextTime += S16; }
  }
  async function hasFile() {
    if (fileChecked !== null) return fileChecked;
    try { const r = await fetch(FILE, { method: 'HEAD' }); fileChecked = r.ok && /audio/.test(r.headers.get('content-type') || ''); } catch (_) { fileChecked = false; }
    return fileChecked;
  }
  async function start() {
    if (playing) return true;
    if (await hasFile()) {
      fileAudio = fileAudio || Object.assign(new Audio(FILE), { loop: true, volume: 0.35 });
      try { await fileAudio.play(); playing = true; return true; } catch (_) { return false; }
    }
    if (!setup()) return false;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) { return false; } }
    if (ctx.state !== 'running') return false;
    playing = true; step = 0; nextTime = ctx.currentTime + 0.08;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0.0001, ctx.currentTime); master.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 1.2);
    clearInterval(schedT); schedT = setInterval(tick, 25); tick();
    return true;
  }
  function stop() {
    if (!playing) return;
    playing = false;
    if (fileAudio) { fileAudio.pause(); }
    if (ctx) {
      clearInterval(schedT);
      const t = ctx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value || 0.0001, t); master.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      setTimeout(() => { if (!playing && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 700);
    }
  }
  global.NBMusic = { start, stop, isPlaying: () => playing, onBeat: (f) => beatListeners.push(f) };
})(typeof window !== 'undefined' ? window : globalThis);
