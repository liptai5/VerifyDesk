// Turns one caller sentence into facts. Uses the AI, or keyword rules in demo mode.

import {
  Extraction,
  RequestedAction,
  SituationClaim,
  Tactic,
  type Turn,
} from "@verifydesk/shared";
import type { LLMProvider } from "./providers/types.js";

// Instructions for the AI. Kept short because Groq's free tier limits words per minute.
export const EXTRACTOR_SYSTEM = `You analyse ONE caller utterance from an IT help-desk phone call.
Extract facts only. Do not judge whether it is an attack.
Return JSON with:
- claimedIdentity: every name AND role the caller claims in this utterance, as said (e.g. "Jane Doe", "the CFO", "Mark, the CFO"), or null.
- requestedAction: one of ${RequestedAction.options.join(", ")}. "mfa_reset" includes moving MFA/authenticator to a new phone or number. "send_code" = asks for a one-time/MFA/verification code to be sent or read out.
- tactics: subset of ${Tactic.options.join(", ")}.
  urgency=time pressure; authority=invokes seniority; isolation=asks for secrecy or to avoid others;
  process_bypass=asks to skip checks; sympathy=emotional appeal; new_contact_channel=wants codes/links sent to a number or email they provide now.
- situation: subset of ${SituationClaim.options.join(", ")}.
- evidenceQuote: the shortest exact phrase from the utterance that supports the tactics or request ("" if none).
- confidence: 0..1.`;

export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    claimedIdentity: { type: ["string", "null"] },
    requestedAction: { type: "string", enum: RequestedAction.options },
    tactics: { type: "array", items: { type: "string", enum: Tactic.options } },
    situation: { type: "array", items: { type: "string", enum: SituationClaim.options } },
    evidenceQuote: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["claimedIdentity", "requestedAction", "tactics", "situation", "evidenceQuote", "confidence"],
};

export function extractorPrompt(turn: Turn, previous?: Turn): string {
  const prev = previous ? `Previous line (${previous.channel}): "${previous.text}"\n` : "";
  return `${prev}Caller utterance: "${turn.text}"`;
}

// This calls the AI for one sentence.
export async function extract(llm: LLMProvider, turn: Turn, previous?: Turn) {
  return llm.json({
    system: EXTRACTOR_SYSTEM,
    user: extractorPrompt(turn, previous),
    schema: Extraction,
    jsonSchema: EXTRACTION_JSON_SCHEMA,
    mockKey: turn.text,
  });
}

const R = (s: string) => new RegExp(s, "i");

// Demo mode: keyword patterns for each kind of request. Add words here to catch more phrasings.
const ACTION_RULES: [RequestedAction, RegExp][] = [
  ["mfa_reset", R("\\b(mfa|authenticator|two[- ]factor|2fa|push notifications?)\\b.*\\b(reset|move|moved|transfer|switch|new (number|phone))|\\b(reset|move|transfer)\\b.*\\b(mfa|authenticator|2fa)\\b")],
  ["send_code", R("\\b(send|give|text|read|email|tell)\\b.*\\b(code|otp|one[- ]time (code|password)|passcode|pin)\\b|\\b(mfa|2fa|login|verification|security) code\\b")],
  ["password_reset", R("\\b(reset|change|unlock)\\b.*\\bpassword\\b|\\bpassword\\b.*\\b(reset|expired|unlock)\\b|locked out")],
  ["new_device", R("\\b(enrol|enroll|register|add|set ?up|activate|connect)\\b.*\\b(device|phone|laptop)\\b|\\bnew (phone|device|laptop)\\b.*\\b(enrol|enroll|register|add|set ?up|set it up|activate|connect)")],
  ["privilege_change", R("\\b(admin|administrator|elevated|privileged?)\\b.*\\b(rights|access|role)\\b")],
  ["payment_change", R("\\b(bank (details|account)|iban|wire|payment details|supplier account)\\b")],
  ["remote_access", R("\\b(anydesk|teamviewer|remote (access|session|desktop)|screen ?share)\\b")],
];

// Demo mode: keyword patterns for pressure tactics.
const TACTIC_RULES: [Tactic, RegExp][] = [
  ["urgency", R("\\b(right now|immediately|urgent|asap|right away|in (a few|ten|10|five|5) minutes|in an hour|deadline|boarding|no time|hurry|quickly|stuck in traffic|running late|meeting (starts|in)|before my (flight|meeting))\\b")],
  ["authority", R("\\b(i'?m the|as the|cfo|ceo|cto|vice president|vp|director|board (meeting|members?)|executive)\\b")],
  ["isolation", R("\\b(don'?t tell|keep (this|it) between|no need to (involve|tell|escalate)|confidential|just you and me)\\b")],
  ["process_bypass", R("\\b(skip|bypass|just this once|make an exception|don'?t have time for|no need for (the )?(check|verification)|forget the (process|procedure)|no verification (is )?needed|without (the |any )?(check|verification)|don'?t need (to |the |a |any )?(verify|verification|check))\\b")],
  ["sympathy", R("\\b(please,? (help|i beg)|desperate|i'?ll (be fired|lose my job)|my job is on the line|really need your help)\\b")],
  ["new_contact_channel", R("\\b(new number|send (it|the code|the link) to|text me at|my personal (email|phone|number)|this number instead)\\b")],
];

// Demo mode: keyword patterns for the caller's story.
const SITUATION_RULES: [SituationClaim, RegExp][] = [
  ["phone_lost", R("\\b(lost|stolen|broke|broken|dropped)\\b.*\\bphone\\b|\\bphone\\b.*\\b(lost|stolen|broke|broken)\\b")],
  ["traveling", R("\\b(airport|flight|boarding|plane|travell?ing|abroad|hotel|in traffic|on the road|driving)\\b")],
  ["new_phone", R("\\bnew (phone|number|mobile)\\b")],
  ["locked_out", R("\\blocked out\\b|\\baccount (is )?locked\\b|\\btoo many (attempts|tries)\\b")],
  ["returning_from_leave", R("\\b(back from|returning from) (leave|holiday|vacation)\\b")],
];

// Demo mode: fills in the same facts with keyword rules instead of calling the AI.
export function heuristicExtract(text: string): Extraction {
  const requestedAction = ACTION_RULES.find(([, re]) => re.test(text))?.[0] ?? "none";
  const tactics = TACTIC_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
  const situation = SITUATION_RULES.filter(([, re]) => re.test(text)).map(([s]) => s);
  const nameMatch =
    text.match(/\b(?:[Tt]his is|I am|I'm|[Mm]y name is|[Ii]t's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z'’-]+)?)/) ??
    text.match(/\b([A-Z][a-z]+\s+[A-Z][a-zA-Z'’-]+)\s+(?:here|speaking)\b/);
  const roleMatch = text.match(/(?:\b(?:i'?m|i am|as|it'?s|this is)|,)\s*the (cfo|ceo|cto|it director|head of [a-z]+|vp of [a-z]+|[a-z]+ director)\b/i);
  const parts = [nameMatch?.[1], roleMatch ? `the ${roleMatch[1]}` : undefined].filter(Boolean);
  const claimedIdentity = parts.length ? parts.join(", ") : null;
  const firstHit = [...TACTIC_RULES, ...ACTION_RULES].map(([, re]) => text.match(re)?.[0]).find(Boolean);
  return {
    claimedIdentity,
    requestedAction,
    tactics,
    situation,
    evidenceQuote: firstHit ?? "",
    confidence: 0.6,
  };
}
