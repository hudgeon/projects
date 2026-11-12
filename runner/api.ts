import { z } from "zod";
import type { Lane, Progress } from "../src/run-model";
import { UPKEEP_AUTH_HEADER, type UpkeepAuth } from "../src/upkeep-model";
import { telemetry, type TelemetryFields } from "../src/telemetry";
import { Failure } from "./native";

type Route = `/api/runner/${"claim" | "heartbeat" | "report" | "browser" | "screenshot" | "document"}`;
type Body = {
  runnerId: string;
  activeRunIds?: string[];
  lanes?: Lane[];
  id?: string;
  generation?: number;
  progress?: Progress;
  screenshotId?: string;
  documents?: boolean;
  lease?: string;
  content?: string;
  failure?: string;
};
// The Worker's runner API. A failure is logged when it starts and at each
// doubling of attempts, its recovery once, so an outage cannot flood logs.
export function runnerClient(endpoint: URL, token: string) {
  const failures = new Map<string, { attempt: number; at: number }>();
  return async function post(route: Route, body: Body, upkeepAuth?: UpkeepAuth) {
    const started = performance.now();
    const failureKey = `${route}:${body.id ?? "pool"}`;
    let response: Response | undefined;
    const context: TelemetryFields = {
      route,
      // A document's id is not a conversation's.
      runId: route === "/api/runner/document" ? undefined : body.id,
      generation: body.generation,
      seq: body.progress?.seq,
    };
    try {
      response = await fetch(new URL(route, endpoint), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(upkeepAuth ? { [UPKEEP_AUTH_HEADER]: upkeepAuth } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Failure(
          "report_failed",
          `Runner request failed (${response.status}).`,
        );
      const result = (await response.json()) as Record<string, unknown>;
      const failure = failures.get(failureKey);
      if (failure) {
        telemetry("runner", "runner_request_recovered", {
          ...context,
          attempt: failure.attempt,
          durationMs: Math.max(0, Date.now() - failure.at),
        });
        failures.delete(failureKey);
      }
      return result;
    } catch (error) {
      const failure = failures.get(failureKey) ?? {
        attempt: 0,
        at: Date.now(),
      };
      failure.attempt++;
      failures.set(failureKey, failure);
      if (Number.isInteger(Math.log2(failure.attempt))) {
        const requestId = z
          .uuid()
          .safeParse(response?.headers.get("X-Projects-Request-Id"));
        telemetry(
          "runner",
          "runner_request_failed",
          {
            ...context,
            attempt: failure.attempt,
            durationMs: Math.round(performance.now() - started),
            status: response?.status,
            requestId: requestId.success ? requestId.data : undefined,
            reason: response?.ok
              ? "invalid_response"
              : response
                ? "http_error"
                : "network_error",
          },
          "warn",
        );
      }
      throw error;
    }
  };
}
export type Post = ReturnType<typeof runnerClient>;
