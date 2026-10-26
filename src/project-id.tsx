import "./project-id.css";
import { Link } from "@tanstack/react-router";
import { ArchiveButton } from "./archive-view";
import { projectSearch, conversationSearch } from "./navigation";
import React, { useState } from "react";

export function projectReference(id: string) {
  const quoted = `'${id.replaceAll("'", "'\\''")}'`;
  return `Project ID: ${id}\nLocate on a connected machine without a browser:\nnode ~/.local/share/project-overview/service.mjs --project ${quoted}`;
}

export function ProjectId({ id }: { id: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="project-reference">
      <button
        type="button"
        className="more"
        title="Copy project ID and local lookup command for Claude or Codex"
        aria-label={`Copy project ID ${id}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(projectReference(id));
            setCopy("copied");
          } catch {
            setCopy("failed");
          }
        }}
      >
        ID: {id}
      </button>
      <span role="status">
        {copy === "copied"
          ? "Copied"
          : copy === "failed"
            ? "Copy failed. Select the text below."
            : ""}
      </span>
      {copy === "failed" && <pre>{projectReference(id)}</pre>}
    </span>
  );
}

export function ProjectHeading({ name, id }: { name?: string; id?: string }) {
  return (
    <>
      <h1 className="page-title">{name ?? "Project"}</h1>
      {id && <ProjectId key={id} id={id} />}
    </>
  );
}

export function ProjectActions({
  id,
  name,
  detail,
  archived,
}: {
  id: string;
  name: string;
  detail: boolean;
  archived: boolean;
}) {
  return (
    <div className="project-actions">
      <ProjectId id={id} />
      {!detail && (
        <Link to="/" search={projectSearch(id)}>
          Open project →
        </Link>
      )}
      <Link to="/" search={conversationSearch(undefined, id)}>
        Conversations
      </Link>
      <Link to="/" search={{ view: "archive", project: id }}>
        Archived items
      </Link>
      <ArchiveButton
        target={{ kind: "project", projectId: id }}
        archived={archived}
        name={name}
      />
    </div>
  );
}
