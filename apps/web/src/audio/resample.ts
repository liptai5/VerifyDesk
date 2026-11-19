// Changes the sound to 16,000 samples a second, which speech-to-text expects.

export function resample(input: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = i * ratio;
    const end = Math.min(input.length, (i + 1) * ratio);
    if (ratio > 1) {
      let sum = 0;
      let n = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) {
        sum += input[j] ?? 0;
        n++;
      }
      out[i] = n ? sum / n : 0;
    } else {
      const j = Math.floor(start);
      const t = start - j;
      out[i] = (input[j] ?? 0) * (1 - t) + (input[j + 1] ?? input[j] ?? 0) * t;
    }
  }
  return out;
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
