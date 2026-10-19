import React, { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Navigation } from "./navigation";
import type { inboxCount } from "./inbox-view";
import { useMe } from "./people-view";

export function useSignOut() {
  const client = useQueryClient();
  return async () => {
    const r = await fetch("/api/auth/logout", { method: "POST" });
    if (r.ok) {
      client.clear();
      location.reload();
    }
  };
}
// The app's header: the views, with what waits on the signed-in person, and
// who they are.
export function Topbar({
  view,
  waiting,
  toHandle,
  inert,
}: {
  view: Navigation["view"];
  waiting: number;
  toHandle: ReturnType<typeof inboxCount>;
  inert: boolean;
}) {
  const me = useMe().data;
  const signOut = useSignOut();
  return (
    <header className="topbar" inert={inert}>
      <Link className="brand" to="/" search={{ view: "today" }}>
        <span className="brand-mark" aria-hidden="true">
          ▤
        </span>
        <span className="brand-name">Projects</span>
      </Link>
      <nav className="tabs" aria-label="Views">
        <Link
          to="/"
          search={{ view: "today" }}
          aria-current={view === "today" ? "page" : undefined}
        >
          Today
          {!!waiting && <span className="tab-count">{waiting}</span>}
        </Link>
        <Link
          to="/"
          search={{ view: "inbox" }}
          aria-current={view === "inbox" ? "page" : undefined}
        >
          Inbox
          {toHandle && (toHandle.todo > 0 || !toHandle.complete) && (
            <span
              className="tab-count"
              title={
                toHandle.complete
                  ? "Emails to handle"
                  : "The inbox read is incomplete or out of date"
              }
            >
              {toHandle.todo || ""}
              {toHandle.complete ? "" : "?"}
            </span>
          )}
        </Link>
        <Link
          to="/"
          search={{ view: "archive" }}
          aria-current={view === "archive" ? "page" : undefined}
        >
          Archive
        </Link>
      </nav>
      <Link className="settings-link" to="/" search={{ view: "health" }} aria-current={view === "health" || view === "project" ? "page" : undefined}>Settings</Link>
      {me && (
        <span className="who" title={me.email}>
          {me.name}
        </span>
      )}
      <button className="signout" onClick={signOut}>
        Sign out
      </button>
    </header>
  );
}
export function SignIn({ done }: { done: () => void }) {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${sent ? "verify" : "request"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Too many attempts. Please try again later."
            : sent
              ? "The code is invalid or expired."
              : "Email delivery is unavailable. Please try again later.",
        );
      if (sent) done();
      else setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <h1>Projects</h1>
      <p>A private overview of your work.</p>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            disabled={sent}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {sent && (
          <>
            <p>
              If this address is allowed, a code is on its way. It expires in 10
              minutes.
            </p>
            <label>
              Sign-in code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="refresh" disabled={busy}>
          {busy ? "Please wait…" : sent ? "Sign in" : "Email me a code"}
        </button>
        {sent && (
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode("");
              setError("");
            }}
          >
            Request another code
          </button>
        )}
      </form>
    </main>
  );
}
