import { tracing } from "cloudflare:workers";
import {
  routeSchema,
  telemetry,
  telemetryFieldsSchema,
  type TelemetryFields,
} from "../src/telemetry";

type Operation =
  | "auth"
  | "conversation.read"
  | "conversation.list"
  | "conversation.create"
  | "conversation.feedback"
  | "conversation.cancel"
  | "conversation.move"
  | "conversation.archive"
  | "conversation.screenshot"
  | "runtime.check"
  | "document.request"
  | "document.read"
  | "document.deliver"
  | "browser.grant"
  | "browser.status"
  | "browser.acquire"
  | "browser.connect"
  | "browser.view"
  | "browser.sign_in"
  | "browser.close"
  | "archive.update"
  | "upkeep.start"
  | "inbox.action"
  | "inbox.read"
  | "push.subscribe"
  | "push.events"
  | "dispatch"
  | "heartbeat"
  | "report";
export function attributes(fields: TelemetryFields) {
  const safe = telemetryFieldsSchema.safeParse(fields);
  if (!safe.success) return;
  tracing
    .getActiveSpan()
    ?.setAttributes(
      Object.fromEntries(
        Object.entries(safe.data).map(([key, value]) => [
          `projects.${key}`,
          value,
        ]),
      ),
    );
}
export function trace<T>(
  operation: Operation,
  fields: TelemetryFields,
  action: () => Promise<T>,
): Promise<T> {
  return tracing.enterSpan(`projects.${operation}`, async (span) => {
    attributes(fields);
    try {
      return await action();
    } catch (error) {
      // Provider/validation errors may contain submitted text. Record a fixed
      // category, preserving the original error only for the existing caller.
      span.recordException({ code: "operation_failed" });
      attributes({ outcome: "failed" });
      telemetry(
        "worker",
        "operation_failed",
        { ...fields, reason: "unexpected" },
        "error",
      );
      throw error;
    }
  });
}
export function requestRoute(pathname: string) {
  const route = routeSchema.safeParse(
    pathname.replace(/^\/api\/runs\/[a-f0-9-]{36}(?=\/|$)/, "/api/runs/:id")
      .replace(/^\/api\/inbox\/threads\/[a-f0-9]{10,40}$/, "/api/inbox/threads/:id")
      .replace(/^\/api\/browser\/[a-f0-9-]{36}\/cdp$/, "/api/browser/:id/cdp")
      .replace(/^\/api\/documents\/[a-f0-9]{64}$/, "/api/documents/:id")
      .replace(/\/screenshots\/[a-f0-9-]{36}$/, "/screenshots/:id"),
  );
  return route.success
    ? route.data
    : pathname.startsWith("/api/")
      ? ("unknown" as const)
      : ("asset" as const);
}
export function observeRequest(
  request: Request,
  action: () => Promise<Response>,
) {
  return tracing.enterSpan("projects.request", async (span) => {
    const started = Date.now();
    const route = requestRoute(new URL(request.url).pathname);
    const requestId = crypto.randomUUID();
    const fields: TelemetryFields = {
      requestId,
      route,
      method: ["GET", "POST", "HEAD", "OPTIONS"].includes(request.method)
        ? (request.method as "GET" | "POST" | "HEAD" | "OPTIONS")
        : "OTHER",
    };
    attributes(fields);
    let response: Response;
    try {
      response = await action();
    } catch {
      span.recordException({ code: "request_failed" });
      fields.reason = "unexpected";
      attributes({ reason: "unexpected" });
      response = new Response("Temporarily unavailable", { status: 503 });
    }
    const durationMs = Math.max(0, Date.now() - started);
    const status = response.status;
    attributes({
      status,
      durationMs,
      outcome: status < 400 ? "accepted" : "rejected",
    });
    // Polling is frequent; retain every error/slow request and mutation, but
    // sample healthy reads/heartbeats/empty claims. Lifecycle events are full.
    const polling =
      request.method === "GET" ||
      request.method === "HEAD" ||
      route === "/api/runner/claim" ||
      route === "/api/runner/heartbeat";
    const sampleRate =
      status >= 400 || durationMs >= 1000 || !polling ? 1 : 0.01;
    if (Math.random() < sampleRate)
      telemetry(
        "worker",
        "request_finished",
        { ...fields, status, durationMs, sampleRate },
        status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      );
    const result = new Response(response.body, {status: response.status, statusText: response.statusText, headers: response.headers, webSocket: response.webSocket});
    result.headers.set("X-Projects-Request-Id", requestId);
    return result;
  });
}
