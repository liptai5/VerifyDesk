// The shapes of all the data the server and the web app share (employees, calls, risk, events). Zod checks
// them.

import { z } from "zod";

export const RiskTier = z.enum(["standard", "elevated", "high"]);
export type RiskTier = z.infer<typeof RiskTier>;

// One person in the company directory.
export const Employee = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  title: z.string(),
  department: z.string(),
  managerId: z.string().nullable(),
  location: z.string(),
  status: z.enum(["active", "on_leave", "terminated", "contractor"]),
  phoneOnFile: z.string(),
  riskTier: RiskTier,
});
export type Employee = z.infer<typeof Employee>;

// A phone, laptop or security key registered to an employee.
export const Device = z.object({
  id: z.string(),
  employeeId: z.string(),
  type: z.enum(["phone", "laptop", "hardware_key"]),
  label: z.string(),
  pushEnabled: z.boolean(),
  lastSeenMinutesAgo: z.number(),
  lastLocation: z.string(),
});
export type Device = z.infer<typeof Device>;

export const IdentityEventType = z.enum([
  "login_success",
  "login_failed",
  "mfa_success",
  "mfa_reset",
  "device_added",
  "password_reset",
  "account_locked",
]);

// Something that happened to an account recently (sign-in, MFA change, new device...).
export const IdentityEvent = z.object({
  id: z.string(),
  employeeId: z.string(),
  type: IdentityEventType,
  minutesAgo: z.number(),
  location: z.string(),
  detail: z.string().optional(),
});
export type IdentityEvent = z.infer<typeof IdentityEvent>;

// A company security rule, shown in the report.
export const Policy = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
});
export type Policy = z.infer<typeof Policy>;

export const Company = z.object({
  name: z.string(),
  domain: z.string(),
  helpdeskName: z.string(),
  employeeCount: z.number(),
});
export type Company = z.infer<typeof Company>;

export const Channel = z.enum(["caller", "agent", "verifier"]);
export type Channel = z.infer<typeof Channel>;

export const Turn = z.object({
  id: z.string(),
  channel: Channel,
  text: z.string(),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
});
export type Turn = z.infer<typeof Turn>;

// What the caller wants done.
export const RequestedAction = z.enum([
  "none",
  "password_reset",
  "mfa_reset",
  "send_code",
  "new_device",
  "privilege_change",
  "payment_change",
  "remote_access",
]);
export type RequestedAction = z.infer<typeof RequestedAction>;

// Pressure tricks a caller can use.
export const Tactic = z.enum([
  "urgency",
  "authority",
  "isolation",
  "process_bypass",
  "sympathy",
  "new_contact_channel",
]);
export type Tactic = z.infer<typeof Tactic>;

// Stories the caller tells about themselves, which we check against the records.
export const SituationClaim = z.enum([
  "phone_lost",
  "traveling",
  "new_phone",
  "locked_out",
  "returning_from_leave",
]);
export type SituationClaim = z.infer<typeof SituationClaim>;

// What the AI pulls out of one caller sentence. Facts only, never the verdict.
export const Extraction = z.object({
  claimedIdentity: z.string().nullable(),
  requestedAction: RequestedAction,
  tactics: z.array(Tactic),
  situation: z.array(SituationClaim).default([]),
  evidenceQuote: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof Extraction>;

// The risk levels shown in the big coloured band.
export const RiskState = z.enum(["SAFE", "WATCH", "ALERT", "UNCERTAIN"]);
export type RiskState = z.infer<typeof RiskState>;

export const ChecklistItemId = z.enum([
  "identity_claimed",
  "record_found",
  "context_checked",
  "out_of_band_sent",
  "out_of_band_result",
  "decision",
]);
export type ChecklistItemId = z.infer<typeof ChecklistItemId>;

// The verdict the rules give after each caller sentence.
export const Assessment = z.object({
  state: RiskState,
  reasons: z.array(z.string()),
  requestedAction: RequestedAction,
  tactics: z.array(Tactic),
  anomalies: z.array(z.string()),
  whisper: z.string().nullable(),
  verifierShouldSpeak: z.boolean(),
});
export type Assessment = z.infer<typeof Assessment>;

export const VerificationStatus = z.enum(["none", "pending", "approved", "denied", "timeout"]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

// Every kind of event that goes into the call log.
export const AuditEventType = z.enum([
  "call_started",
  "turn",
  "extraction",
  "assessment",
  "tool_call",
  "push_sent",
  "push_resolved",
  "decision",
  "verifier_said",
  "agent_decision",
  "call_ended",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

// One entry in the call log. The screen, the report and the tests are all built from these.
export const AuditEvent = z.object({
  seq: z.number(),
  ts: z.number(),
  callId: z.string(),
  type: AuditEventType,
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
