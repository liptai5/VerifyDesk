// Plain-language words for everything the screen shows. Change the wording here.

import type { RiskState } from "@verifydesk/shared";

export const STATE_COPY: Record<RiskState, { word: string; meaning: string }> = {
  SAFE: { word: "Safe", meaning: "Nothing risky requested" },
  WATCH: { word: "Watch", meaning: "Verify before any change" },
  ALERT: { word: "Alert", meaning: "Likely impersonation" },
  UNCERTAIN: { word: "Unsure", meaning: "Signals are unclear, keep listening" },
};

export const STATE_COLOR: Record<RiskState, string> = {
  SAFE: "var(--color-safe)",
  WATCH: "var(--color-watch)",
  ALERT: "var(--color-alert)",
  UNCERTAIN: "var(--color-uncertain)",
};

export const ACTION_LABEL: Record<string, string> = {
  none: "No change requested",
  password_reset: "Password reset",
  mfa_reset: "MFA moved to a new phone",
  send_code: "Send them a login code",
  new_device: "New device enrolment",
  privilege_change: "Access rights change",
  payment_change: "Payment details change",
  remote_access: "Remote access session",
};

export const TACTIC_LABEL: Record<string, string> = {
  urgency: "Time pressure",
  authority: "Pulling rank",
  isolation: "Asks for secrecy",
  process_bypass: "Wants to skip checks",
  sympathy: "Emotional pressure",
  new_contact_channel: "New contact details",
};

export const TOOL_LABEL: Record<string, string> = {
  lookup_employee: "Looked up in the directory",
  get_recent_identity_events: "Read recent sign-in activity",
  send_push_challenge: "Sent a push to the registered phone",
  block_reset: "Blocked the change",
  approve_reset: "Approved the change",
  create_incident_ticket: "Opened a security ticket",
};

export const EVENT_LABEL: Record<string, string> = {
  login_success: "Signed in",
  login_failed: "Failed sign-in",
  mfa_success: "Approved MFA",
  mfa_reset: "MFA reset",
  device_added: "Device added",
  password_reset: "Password reset",
  account_locked: "Account locked",
};

export const SPEAKER: Record<string, string> = {
  caller: "Caller",
  agent: "Agent",
  verifier: "VerifyDesk",
};
