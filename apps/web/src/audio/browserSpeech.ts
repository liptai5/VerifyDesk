// The browser's own speech recognition (Chrome, Edge), used when the server has none.

type Rec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
};

export function browserSpeechAvailable(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

export function startBrowserSpeech(opts: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
}): { stop: () => void } {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Ctor) throw new Error("Browser speech recognition isn't available. Use Chrome or Edge.");
  const rec: Rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  let stopped = false;
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = String(r[0]?.transcript ?? "").trim();
      if (!text) continue;
      if (r.isFinal) opts.onFinal(text);
      else opts.onInterim?.(text);
    }
  };
  rec.onerror = (e: any) => {
    if (e?.error === "no-speech" || e?.error === "aborted") return;
    opts.onError?.(`Browser speech recognition error: ${e?.error ?? "unknown"}`);
  };
  rec.onend = () => {
    if (!stopped) rec.start();
  };
  rec.start();
  return {
    stop: () => {
      stopped = true;
      rec.stop();
    },
  };
}
