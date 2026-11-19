// Connects to the server's live event stream and keeps the console up to date.

import { useEffect, useRef, useState } from "react";
import type { AuditEvent } from "@verifydesk/shared";
import { api } from "../lib/api";
import { applyEvent, buildView, emptyView, type CallView } from "./callView";

export type LinkStatus = "connecting" | "live" | "offline";

export function useCallEvents(callId: string | null) {
  const [view, setView] = useState<CallView>(emptyView);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const callRef = useRef(callId);
  callRef.current = callId;

  useEffect(() => {
    if (!callId) {
      setView(emptyView());
      return;
    }
    let cancelled = false;
    api
      .events(callId)
      .then((events) => !cancelled && setView((prev) => (prev.callId === callId ? events.reduce(applyEvent, prev) : buildView(events))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [callId]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setStatus("live");
        const id = callRef.current;
        if (id) api.events(id).then((evs) => setView((prev) => evs.reduce(applyEvent, prev))).catch(() => {});
      };
      ws.onmessage = (msg) => {
        const e = JSON.parse(String(msg.data)) as AuditEvent;
        if (e.callId !== callRef.current) return;
        setView((prev) => applyEvent(prev.callId ? prev : { ...prev, callId: e.callId }, e));
      };
      ws.onclose = () => {
        setStatus("offline");
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { view, status };
}
