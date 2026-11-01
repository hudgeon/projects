// Native-session presentation, shared by the project and session lists.
import React from "react";
import { Restart } from "./restart";
import { ArchiveButton } from "./archive-view";
import { ago, hostName, machineIdSchema, type Session } from "./model";

export function Badge({
  children,
  tone = "quiet",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function NativeSession({
  session: s,
  host,
  stale,
  now,
}: {
  session: Session;
  host: string;
  stale?: boolean;
  now: number;
}) {
  return (
    <article className="session">
      <div className="session-meta">
        <span>
          {s.app}{" "}
          <span className="subtle">on {hostName(host)}</span>
        </span>
        <Badge
          tone={stale ? "warning" : s.state === "running" ? "good" : "quiet"}
        >
          {stale ? "Last known: " : ""}
          {s.state}
        </Badge>
      </div>
      <p className="session-title">{s.title}</p>
      <span className="subtle">
        {ago(s.updatedAt, now)} · {s.evidence}
      </span>
      <div className="session-actions">
        <Restart app={s.app} id={s.id} host={host} />
        {machineIdSchema.safeParse(host).success && (
          <ArchiveButton
            target={{ kind: "session", host, app: s.app, sessionId: s.id }}
            archived={false}
            name={s.title}
          />
        )}
      </div>
    </article>
  );
}
