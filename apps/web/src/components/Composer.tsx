// The small "Or type a line" box under the microphone.

import { useState, type FormEvent } from "react";

export function Composer({
  disabled,
  onSend,
  channel,
}: {
  disabled: boolean;
  onSend: (channel: "caller" | "agent", text: string) => Promise<void>;
  channel: "caller" | "agent";
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await onSend(channel, value);
      setText("");
    } finally {
      setSending(false);
    }
  };

  const who = channel === "caller" ? "the caller" : "the agent";
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 bg-panel px-6 pt-1 pb-4">
      <label htmlFor="type-line" className="text-sm text-muted">
        Or type a line for {who}:
      </label>
      <input
        id="type-line"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? "Start a call first" : channel === "caller" ? "What the caller says" : "What the agent says"}
        className="min-w-[14rem] flex-1 rounded-md border border-line bg-white px-3 py-1.5 text-sm placeholder:text-muted/70 disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={disabled || sending || !text.trim()}
        className="rounded-md border border-ink px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
      >
        {sending ? "Adding" : "Add line"}
      </button>
    </form>
  );
}
