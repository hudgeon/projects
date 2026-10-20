// A signed-in person's devices and the notices they fetch (worker/push.ts).
// A conversation browser's sign-in never reaches these (browserMay), nor do
// machine tokens.
import { z } from "zod";
import { readJson } from "./auth";
import { pushEndpoint, vapidPublicKey } from "./push";
import { trace } from "./telemetry";
import type { Portfolio } from "./index";

const pushRequestSchema = z
  .object({ endpoint: z.string().max(1000).refine(pushEndpoint) })
  .strict();
type Store = Pick<DurableObjectStub<Portfolio>, "pushEvents" | "subscribePush" | "unsubscribePush" | "rate">;
export async function pushRoutes(
  request: Request,
  store: Store,
  caller: string,
  env: { VAPID_PRIVATE_KEY?: string },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/push/key" && request.method === "GET")
    return env.VAPID_PRIVATE_KEY
      ? Response.json({ key: vapidPublicKey(env.VAPID_PRIVATE_KEY) })
      : Response.json({ error: "Notifications are not set up yet." }, { status: 503 });
  if (url.pathname === "/api/push/events" && request.method === "GET")
    return Response.json(
      { events: await trace("push.events", {}, () => store.pushEvents(caller)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  if ((url.pathname === "/api/push/subscribe" || url.pathname === "/api/push/unsubscribe") && request.method === "POST") {
    let input;
    try {
      input = pushRequestSchema.parse(await readJson(request, 2048));
    } catch {
      return Response.json({ error: "Invalid notification request" }, { status: 400 });
    }
    if (!(await store.rate(`push:${caller}`, 10, 3600_000)))
      return Response.json({ error: "Try again shortly." }, { status: 429 });
    if (url.pathname.endsWith("/unsubscribe")) await store.unsubscribePush(input.endpoint, caller);
    else if (!env.VAPID_PRIVATE_KEY)
      return Response.json({ error: "Notifications are not set up yet." }, { status: 503 });
    else await trace("push.subscribe", {}, () => store.subscribePush(input.endpoint, caller));
    return Response.json({ ok: true });
  }
  return null;
}
