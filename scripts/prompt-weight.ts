// Replays this machine's stored conversations through the engine with
// stand-in native turns, on this checkout's code, and counts what each native
// turn was sent. Nothing native runs: no agent, worktree, GitHub call or Jev
// request, and the replay keeps its own state in a temporary folder. A
// conversation's messages, helpers and their reports are as recorded; which
// project it started in, each helper's task and when it started come from its
// review receipts when those are kept. Reports carry counts only.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { executeRun, type EngineOptions } from "../runner/engine";
import { JEV_MODEL, type ContextConfig } from "../runner/context";
import { reviewsDir } from "../runner/project-turn";
import type { ProjectDirectory } from "../runner/workspaces";
import { agentSchema, childSchema, type Agent, type Child, type Progress, type Run, type RunMessage } from "../src/run-model";
import { clip } from "../src/run-text";

export type Conversation = {
  id: string;
  messages: RunMessage[];
  children: Child[];
  masterAgent: Agent;
  projectId: string | null;
  // By helper: the task it was given and when it started.
  tasks: Record<string, { at: number; task: string }>;
};
export type Turn = {
  kind: "coordinator" | "helper";
  // Whether the turn continued a native session or started one.
  resumed: boolean;
  chars: number;
  images: number;
};
const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "master"]),
  text: z.string(),
  at: z.number(),
  screenshots: z
    .array(z.object({ id: z.uuid(), mime: z.enum(["image/png", "image/jpeg"]), bytes: z.number(), width: z.number(), height: z.number(), sha256: z.string() }))
    .optional(),
});
const journalSchema = z.object({ progress: z.object({ children: z.array(z.unknown()), masterAgent: agentSchema.optional() }) });
const receiptSchema = z.object({ runId: z.string(), actor: z.string(), at: z.number(), projectId: z.string(), input: z.object({ task: z.string() }) });
const json = (file: string) => readFile(file, "utf8").then(JSON.parse);

// Conversations with a journal and their messages on this machine, newest first.
export async function storedConversations(stateDir: string): Promise<Conversation[]> {
  const runs = path.join(stateDir, "runs");
  const names = await readdir(runs).catch(() => [] as string[]);
  const receipts = new Map<string, z.infer<typeof receiptSchema>[]>();
  for (const name of await readdir(reviewsDir(stateDir)).catch(() => [] as string[])) {
    const receipt = receiptSchema.safeParse(await json(path.join(reviewsDir(stateDir), name)).catch(() => null));
    if (receipt.success) receipts.set(receipt.data.runId, [...(receipts.get(receipt.data.runId) ?? []), receipt.data]);
  }
  const found: Conversation[] = [];
  for (const name of names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
    const id = name.slice(0, 36);
    const journal = journalSchema.safeParse(await json(path.join(runs, name)).catch(() => null));
    const messages = z.array(messageSchema).safeParse(await json(path.join(runs, `${id}.context.json`)).catch(() => null));
    if (!journal.success || !messages.success || !messages.data.some((m) => m.role === "user")) continue;
    const own = receipts.get(id) ?? [];
    found.push({
      id,
      messages: messages.data,
      children: journal.data.progress.children.flatMap((child) => {
        const parsed = childSchema.safeParse(child);
        return parsed.success ? [parsed.data] : [];
      }),
      masterAgent: journal.data.progress.masterAgent ?? "codex",
      projectId: own.find((r) => r.actor === "master")?.projectId ?? null,
      tasks: Object.fromEntries(
        own.flatMap((r) => {
          const task = /^(?:read|change): ([\s\S]+)$/.exec(r.input.task)?.[1];
          return task ? [[r.actor, { at: r.at, task }]] : [];
        }),
      ),
    });
  }
  return found.sort((a, b) => b.messages.at(-1)!.at - a.messages.at(-1)!.at);
}

// One execution per reply: the messages it started from and the reply it ended with.
function rounds(messages: RunMessage[]) {
  const found: { messages: RunMessage[]; reply: RunMessage | null }[] = [];
  let open = false;
  for (const [i, message] of messages.entries()) {
    if (message.role === "user") open = true;
    else if (open) {
      found.push({ messages: messages.slice(0, i), reply: message });
      open = false;
    }
  }
  if (open) found.push({ messages, reply: null });
  return found;
}
const gate = { status: "not_required" as const, evidence: "A replay delivers nothing." };
const delivery = { scope: "Replay", checks: gate, review: gate, merge: gate, deployment: gate, visual: gate, sync: gate };

export type Setup = {
  projects: ProjectDirectory[];
  masterCwd: string;
  host: string;
  workRepo?: string;
  agents?: Agent[];
  mode: ContextConfig["mode"];
};
// The native turns one conversation's replay made, or null when the engine
// could not follow the record (a project no longer registered, say).
export async function weigh(c: Conversation, o: Setup): Promise<Turn[] | null> {
  const known = new Set(o.projects.map((p) => p.id));
  const recorded = c.children.filter((child) => known.has(child.projectId) && (o.agents ?? [child.agent]).includes(child.agent));
  const used = [...new Set(recorded.map((child) => child.projectId))];
  const projectId = c.projectId && known.has(c.projectId) && used.every((id) => id === c.projectId) ? c.projectId : used.length === 1 ? used[0] : null;
  const executions = rounds(c.messages);
  // A helper belongs to the execution whose reply followed its start; one
  // with no receipt joins the helper before it.
  let last = 0;
  const execution = recorded.map((child) => {
    const at = c.tasks[child.id]?.at;
    if (at !== undefined) last = Math.max(0, executions.findIndex((e) => !e.reply || e.reply.at >= at));
    return last;
  });
  const stateDir = await mkdtemp(path.join(tmpdir(), "prompt-weight-"));
  const turns: Turn[] = [];
  const id = randomUUID(),
    started = Date.now();
  // The engine's own child and session for each recorded helper.
  const child = new Map<Child, string>(),
    session = new Map<Child, string>();
  let progress: Progress | null = null,
    current: Child | undefined,
    complete = true;
  try {
    for (const [index, round] of executions.entries()) {
      const queue = recorded.filter((_, i) => execution[i] === index);
      const run: Run = {
        id, projectId, agent: "auto", masterAgent: c.masterAgent, workIssue: null, owner: "owner@example.com",
        generation: index + 1, state: "running", createdAt: started, updatedAt: started, heartbeatAt: started,
        messages: round.messages, progress,
      };
      const options: EngineOptions = {
        run,
        projects: o.projects,
        stateDir,
        worktreeRoot: path.join(stateDir, "worktrees"),
        masterCwd: o.masterCwd,
        host: o.host,
        workRepo: o.workRepo,
        agents: o.agents,
        maxSteps: queue.length + 3,
        signal: new AbortController().signal,
        // Each execution sees a later observation, as each real one does.
        activity: [{ host: o.host, observedAt: started + index * 120_000, projects: o.projects.map((p) => ({ id: p.id, sessions: [], worktrees: [], pulls: [], sources: {} })) }],
        report: async (reported) => {
          progress = structuredClone(reported);
        },
        // Jev stands in: every candidate is rated worth keeping.
        contextSelector: {
          mode: o.mode,
          key: async () => "replay",
          fetch: (async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            return Response.json({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 0, output_tokens: 0 } });
          }) as typeof fetch,
        },
        browser: async () => ({ endpoint: "wss://projects.invalid/api/browser/replay/cdp", capability: "replay".repeat(8), outputDir: stateDir }),
        screenshot: async (image) => ({ id: image.id, mime: image.mime, data: "AAAA" }),
        connectors: async () => ({ claude: null, codex: null }),
        readWorkRecord: async (repo, number) => ({ number, body: "", url: `https://github.com/${repo}/issues/${number}` }),
        evidence: async () => current?.evidence.slice(0, 5) ?? [],
        save: async () => null,
        prune: async () => {},
        changes: async () => ({ files: [], total: { files: 0, added: 0, removed: 0 }, at: Date.now() }),
        prepare: async (project, _task, _previous, _run, childId) => {
          child.set(current!, childId);
          // A helper that continued an earlier one's session does so here.
          const earlier = recorded.find((other) => other !== current && !!current!.sessionId && other.sessionId === current!.sessionId && session.has(other));
          return { cwd: project.cwd, branch: current!.branch, sessionId: earlier ? session.get(earlier)! : null };
        },
        turn: async (opts) => {
          const coordinator = "action" in ((opts.schema.properties ?? {}) as object);
          turns.push({ kind: coordinator ? "coordinator" : "helper", resumed: !!opts.sessionId, chars: opts.prompt.length, images: opts.screenshots?.length ?? 0 });
          const native = opts.sessionId ?? randomUUID();
          await opts.onSession(native);
          if (!coordinator) {
            session.set(current!, native);
            return current!.result ?? { outcome: "blocked", summary: "It stopped before reporting.", checks: [], links: [] };
          }
          current = queue.shift();
          if (!current)
            return { action: "complete", title: "Replay", summary: clip(round.reply?.text ?? "Replayed.", 8000), delivery, workRecord: { status: "unchanged", evidence: "A replay changes no record." }, task: null };
          // A change worktree an earlier helper made, or a session it left, is reused; read helpers merely share the checkout.
          const shared = recorded.find((other) => other !== current && child.has(other) && other.host === current!.host && (current!.mode === "change" ? other.mode === "change" && other.cwd === current!.cwd : !!current!.sessionId && other.sessionId === current!.sessionId));
          return {
            action: "dispatch", title: "Replay", summary: "Delegating.",
            task: { projectId: current.projectId, agent: current.agent, mode: current.mode, workspace: shared ? child.get(shared)! : "new", prompt: c.tasks[current.id]?.task ?? "Carry out the assigned work in this project." },
          };
        },
      };
      await executeRun(options);
      complete &&= (progress as Progress | null)?.state === "completed" && !queue.length;
    }
  } catch {
    complete = false;
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
  return complete ? turns : null;
}

const mean = (values: number[]) => (values.length ? values.reduce((n, v) => n + v, 0) / values.length : null);
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
export function weight(replayed: Turn[][], skipped = 0) {
  const turns = replayed.flat();
  const of = (kind: Turn["kind"], resumed: boolean) => {
    const chars = turns.filter((t) => t.kind === kind && t.resumed === resumed).map((t) => t.chars);
    return { turns: chars.length, mean: mean(chars), median: median(chars), max: chars.length ? Math.max(...chars) : null };
  };
  const helpers = turns.filter((t) => t.kind === "helper");
  return {
    conversations: replayed.length,
    skipped,
    turns: turns.length,
    chars: turns.reduce((n, t) => n + t.chars, 0),
    charsPerTurn: mean(turns.map((t) => t.chars)),
    charsPerConversation: mean(replayed.map((c) => c.reduce((n, t) => n + t.chars, 0))),
    kinds: {
      "coordinator, new session": of("coordinator", false),
      "coordinator, resumed": of("coordinator", true),
      "helper, new session": of("helper", false),
      "helper, resumed": of("helper", true),
    },
    imagesPerHelperTurn: mean(helpers.map((t) => t.images)),
  };
}
const num = (value: number | null, digits = 0) => (value === null ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: digits }));
export function formatWeight(report: ReturnType<typeof weight>, title: string) {
  return [
    title,
    `Conversations ${report.conversations} replayed${report.skipped ? `, ${report.skipped} the engine could not follow` : ""}: ${report.turns} native turns, ${num(report.chars)} prompt characters.`,
    `Prompt characters per native turn: ${num(report.charsPerTurn)}; per conversation: ${num(report.charsPerConversation)}. Screenshots per helper turn: ${num(report.imagesPerHelperTurn, 2)}.`,
    "turn | turns | mean chars | median | max",
    ...Object.entries(report.kinds).map(([name, k]) => [name, k.turns, num(k.mean), num(k.median), num(k.max)].join(" | ")),
  ].join("\n");
}
