import React, { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ago,
  hostHealth,
  setMachineNames,
  type HostHealth,
  type MachineView,
  type PortfolioView,
  type Snapshot,
} from "./model";
import { api } from "./overview-query";
const labels: Record<HostHealth["verdict"], string> = {
  clean: "Clean",
  unverified: "Clean where verified",
  progress: "In progress",
  cleanup: "Needs cleanup",
  stale: "Update overdue",
};
const tones: Record<HostHealth["verdict"], string> = {
  clean: "good",
  unverified: "quiet",
  progress: "working",
  cleanup: "warning",
  stale: "warning",
};
function counts(h: HostHealth) {
  const parts = [
    h.changed ? `${h.changed} with uncommitted changes` : "",
    h.unpushed ? `${h.unpushed} with unpushed commits` : "",
    h.active ? `${h.active} in a recent session` : "",
    h.conflicts ? `${h.conflicts} conflicts` : "",
    h.errors ? `${h.errors} unreadable` : "",
    h.unverified ? `${h.unverified} with unknown push state` : "",
    h.behind ? `${h.behind} behind upstream` : "",
    h.extra ? `${h.extra} extra worktrees` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing uncommitted or unpushed";
}
type Tokens = { machine: string; tokens: { collector: string; runner: string } };
// Every change returns the updated list; the overview refreshes behind it.
function useMachineChange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ route, body }: { route: string; body: unknown }) =>
      api<{ machines: MachineView[] } & Partial<Tokens>>(route, body),
    onSuccess: async ({ machines }) => {
      setMachineNames(machines);
      client.setQueryData<PortfolioView>(["overview"], (old) =>
        old ? { ...old, machines } : old,
      );
      await client.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}
const failure = (error: Error | null) =>
  error &&
  (error.message === "SIGN_IN"
    ? "Sign in again to change machines."
    : error.message);
// A machine's tokens are shown once, right after they are made.
function TokenNotice({ value, done }: { value: Tokens; done: () => void }) {
  return (
    <div className="machine-tokens" role="status">
      <p>
        Put these in <strong>{value.machine}</strong>'s setup now. They are not
        shown again; replace them if they are lost.
      </p>
      <dl>
        <dt>Machine</dt>
        <dd>
          <code>{value.machine}</code>
        </dd>
        <dt>Collector token</dt>
        <dd>
          <code>{value.tokens.collector}</code>
        </dd>
        <dt>Runner token</dt>
        <dd>
          <code>{value.tokens.runner}</code>
        </dd>
      </dl>
      <button onClick={done}>Done</button>
    </div>
  );
}
function MachineControls({
  machine,
  last,
  revealed,
}: {
  machine: MachineView;
  last: boolean;
  revealed: (tokens: Tokens) => void;
}) {
  const change = useMachineChange();
  const [name, setName] = useState(machine.name);
  const [removing, setRemoving] = useState(false);
  const route = `/api/machines/${machine.id}`;
  return (
    <div className="machine-controls">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== machine.name)
            change.mutate({ route, body: { name: name.trim() } });
        }}
      >
        <input
          aria-label={`Name for ${machine.name}`}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={change.isPending}>Rename</button>
      </form>
      <button
        disabled={change.isPending || machine.position === 0}
        onClick={() =>
          change.mutate({ route, body: { position: machine.position - 1 } })
        }
      >
        Prefer
      </button>
      <button
        disabled={change.isPending || last}
        onClick={() =>
          change.mutate({ route, body: { position: machine.position + 1 } })
        }
      >
        Prefer less
      </button>
      <button
        disabled={change.isPending}
        onClick={() =>
          change.mutate(
            { route: `${route}/tokens`, body: {} },
            {
              onSuccess: (r) =>
                r.machine && r.tokens && revealed(r as unknown as Tokens),
            },
          )
        }
      >
        Replace tokens
      </button>
      {removing ? (
        <button
          className="danger"
          disabled={change.isPending}
          onClick={() => change.mutate({ route: `${route}/remove`, body: {} })}
        >
          Confirm: remove {machine.name}
        </button>
      ) : (
        <button onClick={() => setRemoving(true)}>Remove</button>
      )}
      {change.error && (
        <span role="alert" className="error">
          {failure(change.error)}
        </span>
      )}
    </div>
  );
}
function AddMachine({ revealed }: { revealed: (tokens: Tokens) => void }) {
  const change = useMachineChange();
  const [name, setName] = useState("");
  return (
    <form
      className="machine-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        change.mutate(
          { route: "/api/machines", body: { name: name.trim() } },
          {
            onSuccess: (r) => {
              setName("");
              if (r.machine && r.tokens) revealed(r as unknown as Tokens);
            },
          },
        );
      }}
    >
      <input
        aria-label="New machine name"
        placeholder="Name a machine to connect"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <button disabled={change.isPending || !name.trim()}>Add machine</button>
      {change.error && (
        <span role="alert" className="error">
          {failure(change.error)}
        </span>
      )}
    </form>
  );
}
// Is every connected machine clean? Answered from each machine's own fresh
// snapshot; one that has not reported, or reported too long ago, is never
// called clean. Machines are listed in preference order: the first one heard
// from recently is on duty and takes new conversations.
export function Machines({
  snapshots,
  machines,
  now,
}: {
  snapshots: Snapshot[];
  machines: MachineView[];
  now: number;
}) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const hosts = machines.map((machine) => {
    const s = snapshots.find((x) => x.host === machine.id);
    return { machine, health: s ? hostHealth(s, now) : null };
  });
  const allClean =
    hosts.length > 0 && hosts.every((h) => h.health?.verdict === "clean");
  return (
    <section className="machines" aria-label="Machines">
      <div className="machines-head">
        <h2 className="section">Machines</h2>
        {hosts.length > 0 && (
          <span className={`badge ${allClean ? "good" : "quiet"}`}>
            {allClean
              ? "Clean: nothing uncommitted or unpushed on any machine"
              : "Not yet clean everywhere"}
          </span>
        )}
      </div>
      {tokens && <TokenNotice value={tokens} done={() => setTokens(null)} />}
      {hosts.length > 0 && (
        <div className="machine-list">
          {hosts.map(({ machine, health }, index) => (
            <details className="machine" key={machine.id}>
              <summary className="machine-summary">
                <span
                  className={`dot ${!health || health.stale ? "stale" : "fresh"}`}
                />
                <strong>{machine.name}</strong>
                {health ? (
                  <span className={`badge ${tones[health.verdict]}`}>
                    {labels[health.verdict]}
                  </span>
                ) : (
                  <span className="badge warning">Not reporting</span>
                )}
                {machine.duties && machine.lastCollected && (
                  <span className="badge quiet">On duty</span>
                )}
                {machine.browserSignIn && (
                  <span
                    className="badge quiet"
                    title="Its conversation browsers start signed in to Projects."
                  >
                    Browser signs in
                  </span>
                )}
                {health && (
                  <span className="machine-counts">{counts(health)}</span>
                )}
                {health && (
                  <span className="subtle machine-meta">
                    {health.repos} repos · {health.worktrees} checkouts ·
                    updated {ago(health.at, now)}
                  </span>
                )}
              </summary>
              {health &&
                (health.problems.length ? (
                  <ul className="machine-problems">
                    {health.problems.map((p, i) => (
                      <li key={i} className={p.tone}>
                        <strong>{p.project}</strong>
                        <span>
                          {p.checkout}
                          {p.path && (
                            <small className="checkout-path">{p.path}</small>
                          )}
                        </span>
                        <span>{p.note}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle machine-note">
                    Every checkout is committed and pushed, and every upstream
                    is known.
                  </p>
                ))}
              <MachineControls
                machine={machine}
                last={index === hosts.length - 1}
                revealed={setTokens}
              />
            </details>
          ))}
        </div>
      )}
      <AddMachine revealed={setTokens} />
    </section>
  );
}
