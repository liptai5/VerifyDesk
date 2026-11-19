// Safety rules that check everything the AI agent proposes. Plain code, no AI calls here, so the AI agent can't
// talk its way past them.

export type AgentTool = "send_push_challenge" | "ask_caller" | "none";
export type LineKind = "verify" | "question" | "approved" | "denied" | "no_phone";

// What the code allows right now. mustPush means the check is sent whatever the AI chose.
export interface Allowed {
  push: boolean;
  ask: boolean;
  mustPush: boolean;
}

export interface LineFacts {
  recordDetails: string[];
  callerSaid: string;
}

interface Rule {
  id: string;
  text: string;
  applies: (kind: LineKind) => boolean;
  broken: (line: string, f: LineFacts) => boolean;
}

const all = () => true;
const lower = (s: string) => s.toLowerCase();

// Rules for every line VerifyDesk says. Add a rule here to block a new kind of line.
export const LINE_RULES: Rule[] = [
  {
    id: "length",
    text: "Lines must be short: at most 45 words.",
    applies: all,
    broken: (l) => !l.trim() || l.trim().split(/\s+/).length > 45,
  },
  {
    id: "numbers_links",
    text: "No numbers, links or email addresses on the call.",
    applies: all,
    broken: (l) => /\d{3,}|https?:|www\.|@|\.(com|net|org|io|example)\b/i.test(l),
  },
  {
    id: "record_details",
    text: "Never tell the caller what the records say (locations, devices, phone numbers, colleagues).",
    applies: all,
    broken: (l, f) =>
      /\b(our records|on file|records show|last seen|was active|logged in from|signed in from)\b/i.test(l) ||
      f.recordDetails.some((d) => d.length >= 3 && lower(l).includes(lower(d)) && !f.callerSaid.includes(lower(d))),
  },
  {
    id: "no_accusation",
    text: "Never accuse the caller: the real employee may be on the line, and an attacker shouldn't learn what gave them away.",
    applies: all,
    broken: (l) => /\b(scam\w*|fraud\w*|attack\w*|impersonat\w*|deepfakes?|fake|hack\w*|suspicious|lying|liar|criminal)\b/i.test(l),
  },
  {
    id: "no_secrets",
    text: "Never ask for or hand out passwords or codes.",
    applies: all,
    broken: (l) =>
      /\b(tell|read|give|share|spell|provide)\b[^.?!]*\b(password|passcode|pin|code)s?\b/i.test(l) ||
      /\b(what'?s|what is|confirm)\s+your\b[^.?!]*\b(password|passcode|pin|code)s?\b/i.test(l) ||
      /\bi'?ll\s+(send|text|read|give)\b[^.?!]*\bcodes?\b/i.test(l) ||
      /\b(here'?s|here is)\s+(your|the)\s+(code|password)\b/i.test(l),
  },
  {
    id: "no_knowledge_questions",
    text: "Don't check identity with personal questions (birthday, address, manager, employee ID): the answers can be looked up or stolen. Only the registered phone counts.",
    applies: all,
    broken: (l) =>
      /\b(date of birth|birthday|born|home address|post ?code|zip code|maiden|manager'?s name|who is your manager|employee (id|number)|staff (id|number)|last (four|4)|social security|first pet|school)\b/i.test(l),
  },
  {
    id: "verify_mentions_phone",
    text: "When a check is sent, the caller must be told it went to the registered phone.",
    applies: (k) => k === "verify",
    broken: (l) => !/\b(phone|device|app)\b/i.test(l),
  },
  {
    id: "is_a_question",
    text: "A question must be one short question.",
    applies: (k) => k === "question",
    broken: (l) => !l.trim().endsWith("?") || (l.match(/\?/g) ?? []).length > 1,
  },
  {
    id: "refusal_is_clear",
    text: "After a declined or impossible check, the line must refuse the request and never sound like it went through.",
    applies: (k) => k === "denied" || k === "no_phone",
    broken: (l) =>
      !/\b(can'?t|cannot|unable|won'?t|not able|isn'?t possible)\b/i.test(l) ||
      /\b(you'?re verified|go ahead|all set|completed?|successful(ly)?|has been (reset|changed|moved|sent|done)|i'?ve (reset|changed|moved|sent you))\b/i.test(l),
  },
  {
    id: "no_change_claims",
    text: "VerifyDesk never makes changes itself: the agent completes the request after verification.",
    applies: (k) => k === "approved",
    broken: (l) => /\b(i'?ve|i have|i'?ll)\s+(now\s+)?(reset|changed|moved|sent|enrolled|unlocked)\b/i.test(l),
  },
];

// Returns the rules a line breaks (none means it's fine).
export function checkLine(line: string, kind: LineKind, f: LineFacts): Rule[] {
  return LINE_RULES.filter((r) => r.applies(kind) && r.broken(line, f));
}

// Fixes the AI's tool choice to what's allowed, and explains any change.
export function enforceTool(proposed: AgentTool, allowed: Allowed): { tool: AgentTool; notes: string[] } {
  if (allowed.mustPush && proposed !== "send_push_challenge") {
    return {
      tool: "send_push_challenge",
      notes: [
        `The AI chose ${proposed === "ask_caller" ? "to ask a question" : "to wait"}, but the policy requires a check on the registered phone for this request, so VerifyDesk sent one anyway.`,
      ],
    };
  }
  if (proposed === "send_push_challenge" && !allowed.push) {
    return { tool: "none", notes: ["The AI wanted to send a check, but that isn't possible yet (no matching employee, or a check was already sent)."] };
  }
  if (proposed === "ask_caller" && !allowed.ask) {
    return { tool: "none", notes: ["Questions are only for finding out who the caller is or what they need, and at most two per call. The question was dropped."] };
  }
  return { tool: proposed, notes: [] };
}

// Details from the records the caller must never hear.
export function recordDetailsFor(
  employee: { location: string; phoneOnFile: string; managerName?: string | null } | null,
  devices: { label: string; lastLocation: string }[],
  otherLocations: string[] = [],
): string[] {
  if (!employee) return [];
  const out = [employee.location, employee.phoneOnFile, ...devices.flatMap((d) => [d.label, d.lastLocation]), ...otherLocations];
  if (employee.managerName) out.push(employee.managerName);
  return [...new Set(out.filter(Boolean))];
}
