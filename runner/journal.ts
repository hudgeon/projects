// A conversation's saved state on its machine, written privately and in
// order, with the events and reports that go with it.
import { mkdir, readFile, rename, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { telemetry, TELEMETRY_LIMIT, type ExecutionEvent } from "../src/telemetry";
import { childResultSchema, deliverySchema, masterDecisionSchema, workRecordSchema, progressSchema, type Progress } from "../src/run-model";
import { NativeBusyError, Failure, NativeStopError } from "./native";
import type { EngineOptions } from "./execution";

const checkpointSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("master"),
      // Checkpoints saved before decisions carried a title remain replayable.
      value: masterDecisionSchema.partial({ title: true }),
      inputIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("child"),
      value: childResultSchema,
      childId: z.string(),
    })
    .strict(),
]);
export type Journal = {
  generation: number;
  phase: "ready" | "master" | "child" | "finished" | "uncertain";
  pid: number | null;
  progress: Progress;
  checkpoint?: z.infer<typeof checkpointSchema>;
  delivery?: z.infer<typeof deliverySchema>;
  workRecord?: z.infer<typeof workRecordSchema>;
};
export async function savePrivate(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
// The conversation's journal on this machine, or a new one. A journal that
// cannot be read, or is missing for a conversation under way, starts nothing.
export async function readJournal(o: EngineOptions, file: string) {
  let journal: Journal | null = null;
  try {
    journal = z
      .object({
        generation: z.number().int().positive(),
        phase: z.enum(["ready", "master", "child", "finished", "uncertain"]),
        pid: z.number().int().positive().nullable(),
        progress: progressSchema,
        checkpoint: checkpointSchema.optional(),
        delivery: deliverySchema.optional(),
        workRecord: workRecordSchema.optional(),
      })
      .strict()
      .parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Failure(
        "journal_problem",
        "This conversation's saved state on its machine could not be read, so nothing was started.\n\n**Your move:** Start a new conversation for this work; this one's saved state on its machine needs repair first.",
      );
  }
  // A conversation the user moved from another machine starts a new
  // coordinator here, keeping that machine's children as history; nothing of
  // its is replayed.
  const movedHere = !journal && !!o.run.movedFrom && !!o.run.progress;
  if (movedHere)
    journal = {
      generation: o.run.generation,
      phase: "ready",
      pid: null,
      progress: {
        seq: 1,
        state: "running",
        ...(o.run.progress!.title ? { title: o.run.progress!.title } : {}),
        summary: "Continuing on this machine with a new coordinator.",
        children: o.run.progress!.children.map((child) => ({
          ...child,
          host: child.host ?? o.run.movedFrom,
          state: child.state === "running" ? "unknown" : child.state,
        })),
        masterSessionId: null,
        ...(o.run.progress!.masterUsage
          ? { masterUsage: o.run.progress!.masterUsage }
          : {}),
        reviewedMessageIds: o.run.progress!.reviewedMessageIds ?? [],
      },
    };
  if (!journal && o.run.progress)
    throw new Failure(
      "journal_problem",
      "This conversation's saved state is missing on its machine, so nothing was started or repeated.\n\n**Your move:** Start a new conversation for this work; this one's saved state on its machine needs repair first.",
    );
  if (!journal)
    journal = {
      generation: o.run.generation,
      phase: "ready",
      pid: null,
      progress: {
        seq: 1,
        state: "running",
        summary: "Master is reviewing the request.",
        children: [],
        masterSessionId: null,
      },
    };
  return { journal, movedHere };
}
// An execution's events, failure reasons and journal writes.
export function openJournal(o: EngineOptions, j: Journal, file: string) {
  const event = (
    name: ExecutionEvent["event"],
    fields: Omit<ExecutionEvent, "id" | "at" | "event"> = {},
  ) => {
    const entry: ExecutionEvent = {
      id: randomUUID(),
      at: Date.now(),
      event: name,
      ...fields,
    };
    j.progress.telemetry = [...(j.progress.telemetry ?? []), entry].slice(
      -TELEMETRY_LIMIT,
    );
    telemetry("runner", name, {
      ...fields,
      at: entry.at,
      eventId: entry.id,
      runId: o.run.id,
      generation: o.run.generation,
    });
  };
  // A failure's type names its reason, never its text, and no message or stack
  // leaves this machine. A stop the runner made names the interruption it
  // caused, except a native process not confirmed stopped or a busy model.
  const failureReason = (
    error: unknown,
  ): NonNullable<ExecutionEvent["reason"]> => {
    if (error instanceof NativeStopError) return "process_unconfirmed";
    if (error instanceof NativeBusyError) return "model_busy";
    if (o.signal.aborted)
      return o.signal.reason === "shutdown"
        ? "shutdown"
        : o.signal.reason === "cancelled"
          ? "cancelled"
          : "claim_lost";
    if (error instanceof z.ZodError) return "invalid_result";
    return error instanceof Failure ? error.reason : "native_error";
  };
  // Local persistence must never wait behind a network retry. Both queues retain
  // ordering, and every immutable receipt is on disk before it can be delivered.
  let writes = Promise.resolve();
  let deliveries = Promise.resolve();
  const enqueue = (report: boolean) => {
    const snapshot = structuredClone(j);
    const saved = writes.then(() => savePrivate(file, snapshot));
    writes = saved.catch(() => {});
    if (!report) return saved;
    const delivered = deliveries.then(async () => {
      await saved;
      await o.report(snapshot.progress);
    });
    deliveries = delivered.catch(() => {});
    return delivered;
  };
  const persist = () => enqueue(false);
  const publish = (state: Progress["state"], summary: string) => {
    j.progress = { ...j.progress, seq: j.progress.seq + 1, state, summary };
    return enqueue(true);
  };
  // Reports that failed to reach the Worker: the native turn's own outcome
  // is unaffected, and its saved receipt is delivered on the next claim.
  const undelivered = new WeakSet<object>();
  const delivery = (error: unknown) => {
    if (error && typeof error === "object") undelivered.add(error);
    return error;
  };
  return { event, failureReason, persist, publish, undelivered, delivery };
}
