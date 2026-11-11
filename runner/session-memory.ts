// What each native session of a conversation holds from being sent it once:
// its standing instructions, the project view it was given and the
// instruction files that came with it. Kept beside the journal, so a resumed
// session is sent only what it lacks or what changed. A session that compacts
// its history may hold none of it: everything is forgotten then, and whatever
// that turn sent does not count as held.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { savePrivate } from "./journal";

export const STANDING_APPLY = "Your standing instructions from earlier in this session still apply.";
const heldSchema = z.object({
  standing: z.string().optional(),
  view: z.string().optional(),
  instructions: z.record(z.string(), z.string()).optional(),
});
export type Held = z.infer<typeof heldSchema>;
export type SessionMemory = ReturnType<typeof sessionMemory>;
export function sessionMemory(stateDir: string, runId: string) {
  const file = path.join(stateDir, "runs", `${runId}.sessions.json`);
  const sessions = readFile(file, "utf8").then(
    (text) => z.record(z.string(), heldSchema).parse(JSON.parse(text)),
    () => ({}) as Record<string, Held>,
  ).catch(() => ({}) as Record<string, Held>);
  // Sessions that compacted during the turn now running.
  const lost = new Set<string>();
  let saved = Promise.resolve();
  // A failed write only means something is sent once more.
  const save = (all: Record<string, Held>) => (saved = saved.then(() => savePrivate(file, all)).catch(() => {}));
  return {
    // At the start of a turn: what its session holds. Nothing for a new one.
    async held(session?: string | null): Promise<Held> {
      if (!session) return {};
      lost.delete(session);
      return (await sessions)[session] ?? {};
    },
    // After a turn: what it sent, unless the session compacted meanwhile.
    async keep(session: string | null | undefined, sent: Held) {
      if (!session || lost.has(session)) return;
      const all = await sessions;
      all[session] = { ...all[session], ...sent };
      await save(all);
    },
    async forget(session: string) {
      lost.add(session);
      const all = await sessions;
      delete all[session];
      await save(all);
    },
  };
}
