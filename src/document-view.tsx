import React, { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  DOCUMENT_SANDBOX,
  htmlSource,
  type DocumentFailure,
  type DocumentStatus,
} from "./document-model";
import { withDocument } from "./navigation";

const reasons: Record<DocumentFailure, string> = {
  not_found:
    "GitHub has no such file at that commit, or the machine's GitHub login cannot read it.",
  too_large: "This file is larger than Projects opens (5 MB).",
  not_html: "This file is not a web page.",
  unavailable: "The machine could not read it from GitHub.",
  no_machine:
    "No connected machine picked this up. Check that a machine's runner is running, then try again.",
};
async function ask(url: string, retry = false): Promise<DocumentStatus> {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, retry }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    document?: DocumentStatus;
    error?: string;
  };
  if (!response.ok || !body.document)
    throw new Error(body.error ?? "This document cannot open right now.");
  return body.document;
}
// Opens a document link inside Projects instead of on GitHub.
export function useOpenDocument() {
  const navigate = useNavigate();
  return (url: string) =>
    void navigate({ to: "/", search: (prev) => withDocument(prev, url) });
}
// A committed HTML mockup or slide deck, full screen over the current view.
// Its frame runs the file's own scripts in an opaque origin, so slide
// navigation, notes and mockup interactions work without reaching Projects.
export function DocumentViewer({ url }: { url: string }) {
  const source = htmlSource(url)!;
  const name = source.path.split("/").at(-1)!;
  const navigate = useNavigate();
  const client = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const key = ["document", url];
  const status = useQuery({
    queryKey: key,
    queryFn: () => ask(url),
    refetchInterval: (query) =>
      query.state.data?.state === "pending" ? 1500 : false,
    retry: false,
  });
  const again = useMutation({
    mutationFn: () => ask(url, true),
    onSuccess: (document) => client.setQueryData(key, document),
  });
  // The page's own hash changes share the tab's history, so Back here never
  // steps through them: it replaces the viewer with the view beneath.
  const close = () =>
    void navigate({ to: "/", search: (prev) => withDocument(prev), replace: true });
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  });
  const document_ = status.data;
  const failed = status.error ?? again.error;
  return (
    <div className="doc-viewer" role="dialog" aria-modal="true" aria-label={name}>
      <header className="doc-viewer-bar">
        <button className="btn-quiet doc-viewer-close" onClick={close}>
          ← Back
        </button>
        <div className="doc-viewer-title">
          <strong>{name}</strong>
          <span>
            {source.repo}/{source.path} · saved {source.commit.slice(0, 7)}
          </span>
        </div>
        <div className="doc-viewer-actions">
          {document_?.content && document.fullscreenEnabled && (
            <button
              className="btn-quiet"
              onClick={() => void frame.current?.requestFullscreen().catch(() => {})}
            >
              Full screen
            </button>
          )}
          <a href={url} target="_blank" rel="noreferrer">
            Source
          </a>
        </div>
      </header>
      <div className="doc-viewer-body">
        {document_?.content ? (
          <iframe
            ref={frame}
            src={document_.content}
            title={name}
            sandbox={DOCUMENT_SANDBOX}
            allow="fullscreen"
            referrerPolicy="no-referrer"
            onLoad={(event) => event.currentTarget.focus()}
          />
        ) : (
          <div className="doc-viewer-state">
            {failed ? (
              <p>{failed.message}</p>
            ) : document_?.state === "failed" ? (
              <p>{reasons[document_.reason ?? "unavailable"]}</p>
            ) : (
              <p>Getting this edition from a connected machine…</p>
            )}
            {(failed || document_?.state === "failed") && (
              <button
                className="btn"
                disabled={again.isPending}
                onClick={() => again.mutate()}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
