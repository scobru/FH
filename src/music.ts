// Original ambient music, made live with WebAudio (no file): a slow arpeggio over four soft chords, a pad, an echo and a melody
// that takes two different phrases over eight chords before it repeats. Written for FH; not a transcription of any existing piece.
const CHORDS = [ // MIDI notes: Dmaj9, Gmaj7(#11), Bm7, Asus2
  [50, 57, 61, 64, 66], [43, 55, 59, 61, 66], [47, 54, 57, 62, 66], [45, 52, 57, 59, 64],
];
// The melody, per chord of the 8-chord cycle: [eighth-note step within the chord, MIDI note, length in eighths]. D major scale.
const MELODY: [number, number, number][][] = [
  [[0, 81, 6], [6, 78, 2], [8, 76, 4], [12, 78, 3]], [[0, 79, 4], [4, 78, 2], [6, 74, 2], [8, 78, 5], [13, 73, 3]],
  [[0, 83, 4], [4, 81, 2], [6, 78, 2], [8, 81, 4], [12, 78, 3]], [[0, 76, 6], [6, 81, 2], [8, 83, 4], [12, 81, 3]],
  [[0, 86, 4], [4, 83, 2], [6, 81, 2], [8, 78, 4], [12, 81, 3]], [[0, 83, 4], [4, 79, 2], [6, 78, 2], [8, 79, 4], [12, 73, 3]],
  [[0, 81, 6], [6, 83, 2], [8, 86, 4], [12, 83, 3]], [[0, 83, 4], [4, 81, 2], [6, 76, 2], [8, 81, 8]],
];
const BEAT = 60 / 66 / 2; // eighth notes at 66 bpm
const hz = (n: number) => 440 * 2 ** ((n - 69) / 12);

let ctx: AudioContext | null = null;
let timer: number | undefined;

function voice(c: AudioContext, out: AudioNode, note: number, at: number, len: number, gain: number, type: OscillatorType) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.value = hz(note);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + Math.min(0.04, len / 4) + (type === "sine" ? 0 : len / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + len + 0.05);
}

export function startMusic() {
  if (ctx) return;
  const c = (ctx = new AudioContext());
  const master = c.createGain(), echo = c.createDelay(), back = c.createGain(), soft = c.createBiquadFilter();
  master.gain.value = 0.18;
  soft.type = "lowpass"; soft.frequency.value = 2200;
  echo.delayTime.value = BEAT * 3; back.gain.value = 0.35;
  soft.connect(master).connect(c.destination);
  soft.connect(echo).connect(back).connect(echo); // feedback echo
  back.connect(master);
  let step = 0, next = c.currentTime + 0.1;
  const UP_DOWN = [0, 1, 2, 3, 4, 3, 2, 1];
  // schedule a little ahead of time so timers that fire late do not stutter
  const tick = () => {
    while (next < c.currentTime + 0.5) {
      const bar = Math.floor(step / 16) % MELODY.length, chord = CHORDS[bar % CHORDS.length], i = step % 16;
      if (i === 0) chord.slice(1).forEach((n) => voice(c, soft, n - 12, next, BEAT * 16, 0.05, "triangle")); // the pad
      if (i % 8 === 0) voice(c, soft, chord[0] - 12, next, BEAT * 8, 0.22, "sine"); // the bass
      if (i < 14) voice(c, soft, chord[UP_DOWN[i % 8]] + 12, next, BEAT * 3, 0.1, "sine"); // the arpeggio, resting at the end of each chord
      MELODY[bar].filter(([at]) => at === i).forEach(([, n, len]) => voice(c, soft, n, next, BEAT * len, 0.08, "triangle")); // the melody
      step++;
      next += BEAT;
    }
  };
  tick();
  timer = window.setInterval(tick, 100);
}

export function stopMusic() {
  clearInterval(timer);
  void ctx?.close();
  ctx = null;
}
