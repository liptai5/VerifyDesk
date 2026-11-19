// Small helpers for showing times and the underlined evidence quote.

export function ago(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.round(minutes / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function splitEvidence(text: string, quote?: string): [string, string, string] | null {
  if (!quote) return null;
  const i = text.toLowerCase().indexOf(quote.toLowerCase());
  if (i < 0) return null;
  return [text.slice(0, i), text.slice(i, i + quote.length), text.slice(i + quote.length)];
}
