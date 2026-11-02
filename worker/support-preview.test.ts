import { test } from "node:test";
import assert from "node:assert/strict";
import { supportPreviewRoutes } from "./support-preview";
import type { SupportEnvironment } from "./support-investigation";
import type { MachineCaller } from "./machines";

test("only a collector on duty can exchange preview jobs; no caller-selected customer, read or email operation", async () => {
  const calls: string[] = [];
  const job = { id: `${Date.now()}-${crypto.randomUUID()}`, region: "uk", claim: crypto.randomUUID(), message: "The export is empty." };
  const env = { SUPPORT_APP_URL: "https://app.example.com", SUPPORT_READER: { async fetch(request: Request) {
    calls.push(new URL(request.url).pathname);
    assert.equal(await request.text(), "{}"); return Response.json({ job });
  } } as Fetcher } as SupportEnvironment;
  const collector: MachineCaller = { role: "collector", machine: "fixture", plainOwner: false };
  const request = (body: object) => new Request("https://example.com/api/collector/support-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const invoke = (body: object, caller: string | MachineCaller = collector, duty = true) => supportPreviewRoutes(request(body), caller, async () => duty, env, async () => true);
  assert.equal((await invoke({ action: "poll" }, "person@example.com"))?.status, 403);
  assert.equal((await invoke({ action: "poll" }, { ...collector, role: "runner" }))?.status, 403);
  assert.equal((await invoke({ action: "poll" }, collector, false))?.status, 403);
  assert.equal(calls.length, 0);
  for (const body of [{ action: "read", operation: "invoice_context" }, { action: "send" }, { action: "poll", customer: "other" }, { action: "poll", owner: "other@example.com" }])
    assert.equal((await invoke(body))?.status, 503);
  const response = (await invoke({ action: "poll" }))!;
  assert.deepEqual(await response.json(), { job });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, ["/preview/poll"]);
});
