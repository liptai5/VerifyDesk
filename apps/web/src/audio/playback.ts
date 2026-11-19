// Plays the script audio and pauses the microphone meanwhile, so the laptop doesn't hear itself.

let playing = 0;
const listeners = new Set<(p: boolean) => void>();

export function isPlaying() {
  return playing > 0;
}

export function onPlayingChange(fn: (p: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function set(delta: number) {
  playing = Math.max(0, playing + delta);
  for (const l of listeners) l(playing > 0);
}

// Pauses the microphone until the returned function is called.
export function holdMic(): () => void {
  set(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setTimeout(() => set(-1), 250);
  };
}

export async function playUrl(url: string): Promise<void> {
  const audio = new Audio(url);
  set(1);
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error(`Couldn't play ${url}`));
      audio.play().catch(reject);
    });
  } finally {
    setTimeout(() => set(-1), 250);
  }
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url} (${res.status})`);
  return res.blob();
}
