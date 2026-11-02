import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { acknowledgmentText, groundedSupportSummary, supportText } from "../src/support-model";
import { summarizeSupport } from "./support-summary";
import type { Site } from "./upload";
import { telemetry } from "../src/telemetry";

const jobSchema = z.object({ id: z.string().regex(/^\d{13}-[a-f0-9-]{36}$/), region: z.enum(["au", "uk"]), claim: z.uuid(), message: z.string().min(1).max(12_000) }).strict();
// Preview and mailbox preparation call the same classifier and renderer.
export async function previewSupport(message: string, directory: string, version: string, summarize = summarizeSupport) {
  const at = Date.now();
  const summary = groundedSupportSummary(await summarize(message, directory), message);
  return { ...summary, inputUsed: supportText(message), reply: acknowledgmentText(summary), version, durationMs: Date.now() - at };
}
export function startSupportPreview(site: Site, stateDir: string) {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const failures = new Set<"poll" | "native" | "finish">();
  const failed = (phase: "poll" | "native" | "finish") => {
    if (!failures.has(phase)) telemetry("collector", "support_preview_unavailable", { supportPreviewPhase: phase }, "warn");
    failures.add(phase);
  };
  const recovered = (phase: "poll" | "native" | "finish") => { if (failures.delete(phase)) telemetry("collector", "support_preview_recovered", { supportPreviewPhase: phase }); };
  const request = async (body: object) => {
    const response = await fetch(new URL("/api/collector/support-preview", site.endpoint), { method: "POST", headers: site.headers,
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error("Support preview unavailable");
    return response.json();
  };
  const version = readFile(path.join(stateDir, "release.json"), "utf8").then(text => {
    const release = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean().optional() }).passthrough().parse(JSON.parse(text));
    return release.dirty ? "unreleased" : release.commit;
  }).catch(() => "unreleased");
  const tick = async () => {
    let phase: "poll" | "native" | "finish" = "poll";
    try {
      const duty = await fetch(new URL("/api/collector/duties", site.endpoint), { headers: site.headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!duty.ok) throw Error("Support preview duty unavailable");
      const availability = z.object({ duties: z.boolean(), supportInvestigation: z.boolean() }).passthrough().parse(await duty.json());
      if (!availability.duties || !availability.supportInvestigation || stopped) return;
      const { job: raw } = z.object({ job: jobSchema.nullable() }).strict().parse(await request({ action: "poll" }));
      recovered("poll");
      if (!raw || stopped) return;
      const { message, ...job } = raw;
      let result;
      phase = "native";
      try { result = await previewSupport(message, path.join(stateDir, "support-summary"), await version); recovered("native"); }
      catch { failed("native"); }
      phase = "finish";
      if (!stopped) { await request({ action: "finish", ...job, ...(result ? { result } : {}) }); recovered("finish"); }
    } catch { failed(phase); }
    // Four polls/minute fit the application's existing five/minute limit.
    finally { if (!stopped) timer = setTimeout(() => void tick(), 15_000); }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
