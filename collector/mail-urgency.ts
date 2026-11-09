// This runs on the machine before the queue read leaves it. The patterns
// look for an explicit incident, deadline or time-sensitive request.
export function urgentMail(subject: string, body: string, header: (name: string) => string, labels: string[]) {
  const incident = /^(?:(?:re|fwd):\s*)*(?:\[ops alert\]|\[incident\]|\[validation failed\]|\[sev[- ]?[01]\]|\[p[01]\])/i;
  if (incident.test(subject)) return true;
  if (header("List-Id") || labels.includes("CATEGORY_PROMOTIONS") ||
      (header("Auto-Submitted") && header("Auto-Submitted").toLowerCase() !== "no")) return false;
  const footer = /\bif you (?:are not the intended recipient|(?:have )?receive[ds]? (?:this|the) (?:e-?mail|message|communication) in error)\b/i;
  const text = subject + "\n" + body.split(footer, 1)[0];
  return /\burgent\b|\btime[- ]sensitive\b/i.test(subject.replace(/\bnot (?:urgent|time[- ]sensitive)\b/gi, "")) ||
    /\b(?:production|service|system) (?:is down|outage|unavailable)\b/i.test(text) ||
    /\b(?:please|need (?:you|this|a response)|can you|must|action required)\b[^.!?\n]{0,100}\b(?:today|asap|immediately|within (?:an?|one|two|\d+) hours?)\b/i.test(text) ||
    /\b(?:start blocking|stop (?:accepting|processing)|(?:block|suspend) access)\b[^.!?\n]{0,70}\b(?:today|tomorrow|this week)\b/i.test(text) ||
    /^(?:high|urgent)$/i.test(header("Importance"));
}
