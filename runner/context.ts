import { createHash } from "node:crypto";
import type { Child, RunMessage } from "../src/run-model";
import { childContext } from "./child-report";
export { childContext } from "./child-report";

// A fresh coordinator is rebuilt, not replayed: the first request and the
// newest user messages within this budget, every proposal those messages
// answered, the latest reported position and one line for each helper. The
// bounded prompt is a view of the retained sources, not a new source of
// authority; the exact conversation and every report stay on disk.
export const HANDOVER_CHAR_LIMIT = 8_000;
export const EVIDENCE_CHAR_LIMIT = 24_000;
const POLICY = 1;

export function contextConversation(messages: RunMessage[]) {
  const users = messages.filter((message) => message.role === "user");
  const selected = users.length ? [users[0]] : [];
  let chars = selected[0]?.text.length ?? 0;
  for (let i = users.length - 1; i > 0; i--) {
    if (
      selected.length > 1 &&
      chars + users[i].text.length > HANDOVER_CHAR_LIMIT
    )
      break;
    selected.splice(1, 0, users[i]);
    chars += users[i].text.length;
  }
  return {
    userInstructions: selected,
    omittedUserInstructions: users.length - selected.length,
    latestReportedPosition:
      messages.findLast((message) => message.role === "master") ?? null,
  };
}

// What a coordinator starting without its predecessor's session is given of
// the conversation. A short approval's preceding proposal travels with it,
// verbatim and newest first within the evidence budget; every user exchange
// is treated this way, without guessing which ones grant permission. Nothing
// here is judged by a model: a handover is rebuilt by fixed rules.
export function rebuildContext(messages: RunMessage[], children: Child[]) {
  const conversation = contextConversation(messages);
  const selectedUsers = new Set(conversation.userInstructions.map((m) => m.id));
  const proposals = messages.filter(
    (m, i) => m.role === "master" && selectedUsers.has(messages[i + 1]?.id),
  );
  let proposalChars = 0;
  const approvalContext = proposals
    .toReversed()
    .filter((m) => {
      if (proposalChars + m.text.length > EVIDENCE_CHAR_LIMIT) return false;
      proposalChars += m.text.length;
      return true;
    })
    .reverse();
  return {
    version: contextVersion(messages, children),
    conversation,
    approvalContext,
    omittedProposals: proposals.length - approvalContext.length,
    children: childContext(children),
    sources: messages.map((m) => ({ id: m.id, role: m.role, at: m.at })),
    childSources: children.map((c) => ({ id: c.id, state: c.state })),
  };
}

export function contextVersion(messages: RunMessage[], children: Child[]) {
  return createHash("sha256")
    .update(JSON.stringify({ policy: POLICY, messages, children }))
    .digest("hex");
}
