// Records the microphone and hands the sound over in small pieces.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("vd-tap", Tap);
`;

export interface MicHandle {
  sampleRate: number;
  stop: () => void;
}

// Turns the microphone on. Echo cancellation and noise suppression are on.
export async function startMic(onFrame: (frame: Float32Array) => void, frameMs = 20): Promise<MicHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't use the microphone here. Use Chrome or Edge on http://localhost.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "vd-tap");
  const frameSize = Math.round((ctx.sampleRate * frameMs) / 1000);
  let pending = new Float32Array(0);

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const merged = new Float32Array(pending.length + e.data.length);
    merged.set(pending);
    merged.set(e.data, pending.length);
    let off = 0;
    while (off + frameSize <= merged.length) {
      onFrame(merged.slice(off, off + frameSize));
      off += frameSize;
    }
    pending = merged.slice(off);
  };
  source.connect(tap);

  return {
    sampleRate: ctx.sampleRate,
    stop: () => {
      tap.port.onmessage = null;
      source.disconnect();
      tap.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
