// Synthetic/public data only. Use a scoped evaluation key, or --machine for
// its existing scoped key and gateway. No secrets, prompts or errors are printed.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { machineSecret } from "../collector/collect";
import {
  childContext,
  contextConversation,
  contextConfigSchema,
  JEV_MODEL,
  JEV_INPUT_COST_PER_TOKEN,
  OMIT_BELOW,
  selectContext,
} from "../runner/context";
import type { Child, RunMessage } from "../src/run-model";

const cases = [
  {
    name: "calibration-build",
    goal: "Fix the CSV importer; verify the delimiter and final production build. Never send email.",
    relevant:
      "The actual fixture uses a pipe delimiter, not a comma. Preserve the quoted pipe regression case.",
    irrelevant:
      "The unrelated calendar page has a blue heading and a two-column layout.",
  },
  {
    name: "calibration-approval",
    goal: "Prepare a deployment proposal only. Preserve the exact approval scope and show the current commit's tests.",
    relevant:
      "Prior approval covered drafting the proposal only; deployment permission has not been granted.",
    irrelevant:
      "An old unrelated image export used JPEG quality 80 and a 1200-pixel canvas.",
  },
  {
    name: "calibration-recovery",
    goal: "Recover a queued import without repeating a write that may already have completed.",
    relevant:
      "The import timed out after submission; its side effect is unconfirmed. Inspect the external receipt before any retry.",
    irrelevant:
      "A discarded typography experiment used a serif font with 1.4 line spacing.",
  },
  {
    name: "holdout-build",
    goal: "Repair a JSON export; preserve timezone handling and verify its current release.",
    relevant:
      "The export fixture expects UTC timestamps even when the machine is in a different timezone. Keep that regression check.",
    irrelevant:
      "The unrelated chess tutorial explains the knight's move using a diagram.",
  },
  {
    name: "holdout-approval",
    goal: "Create a saved draft announcement. Publishing still requires separate approval.",
    relevant:
      "The owner approved saving a draft, and explicitly withheld permission to publish or email the announcement.",
    irrelevant:
      "The abandoned weather demo displayed rounded temperature tiles.",
  },
  {
    name: "holdout-recovery",
    goal: "Continue a failed artifact upload and verify whether the remote write completed before retrying.",
    relevant:
      "The remote upload returned no acknowledgment after sending the bytes. Its existence must be checked before another upload.",
    irrelevant:
      "The old unrelated recipe list sorted ingredients by their color.",
  },
];
const machine = process.argv.includes("--machine")
  ? JSON.parse(
      await readFile(
        path.join(homedir(), ".local/share/project-overview/machine.json"),
        "utf8",
      ),
    )
  : undefined;
const context = contextConfigSchema.parse(machine?.context ?? {});
const key = machine
  ? await machineSecret(machine, "JEV_API_KEY")
  : (process.env.API_KEY ?? process.env.TYPESAFE_API_KEY);
delete process.env.API_KEY;
delete process.env.TYPESAFE_API_KEY;
if (!process.argv.includes("--live") || !key)
  throw Error("Use --live with a scoped evaluation key or --machine.");
const rows = [];
for (const c of cases) {
  const messages: RunMessage[] = [
    { id: randomUUID(), role: "user", text: c.goal, at: 1 },
  ];
  const children: Child[] = Array.from({ length: 8 }, (_, i) => ({
    id: randomUUID(),
    projectId: "example/project",
    agent: "codex",
    mode: "read",
    cwd: "/tmp/example",
    branch: "owned",
    state: "completed",
    sessionId: randomUUID(),
    evidence: [
      "This is a synthetic historical report, not live delivery proof.",
    ],
    result: {
      outcome: "completed",
      summary:
        i === 0
          ? c.relevant
          : i === 7
            ? "Current task remains open; verify live evidence before declaring completion."
            : c.irrelevant,
      checks: i === 0 ? [c.relevant] : Array(3).fill(c.irrelevant),
      links: [],
    },
  }));
  const view = await selectContext({
    messages,
    children,
    signal: AbortSignal.timeout(15_000),
    selector: {
      mode: "select",
      gateway: context.gateway,
      key: async () => key,
    },
  });
  const selected = JSON.parse(view.children);
  const full = (selected.retained ?? selected.latest) as Child[];
  const baseline = JSON.parse(childContext(children, 6));
  rows.push({
    name: c.name,
    strategy: view.strategy,
    reason: view.reason,
    protectedInstructionsIntact:
      JSON.stringify(view.conversation) ===
      JSON.stringify(contextConversation(messages)),
    executionIndexIntact: selected.index.length === children.length,
    usefulEvidenceMissing: !full.some((child) => child.id === children[0].id),
    baselineUsefulEvidenceMissing: !baseline.latest.some(
      (child: Child) => child.id === children[0].id,
    ),
    baselineChars: childContext(children, 6).length,
    selectedChars: view.children.length,
    probabilities: view.record?.probabilities,
    inputTokens: view.record?.inputTokens,
    outputTokens: view.record?.outputTokens,
    latencyMs: view.record?.durationMs,
    // Published Jev 1.14 price, checked 2026-10-18: $0.042/M input tokens;
    // output is free. This estimates billed cost, not an invoice readback.
    estimatedCostUsd: view.record
      ? view.record.inputTokens * JEV_INPUT_COST_PER_TOKEN
      : null,
  });
}
const report = {
  at: new Date().toISOString(),
  model: JEV_MODEL,
  omitBelow: OMIT_BELOW,
  data: "synthetic",
  rows,
  passed: rows.every(
    (r) =>
      r.strategy === "select" &&
      r.protectedInstructionsIntact &&
      r.executionIndexIntact &&
      !r.usefulEvidenceMissing &&
      r.selectedChars < r.baselineChars,
  ),
  limits:
    "Measures selection and source retention. It does not establish native-agent behavior, duplicate-execution rates, production token savings or end-to-end delivery accuracy.",
};
await mkdir(".wip", { recursive: true });
await writeFile(
  ".wip/jev-context-evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
