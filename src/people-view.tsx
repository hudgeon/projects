import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, privateQueryPolicy } from "./overview-query";
import { NAME_LIMIT, personName, type Person } from "./people-model";

// The signed-in person, as the Worker knows them.
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<Person>("/api/me"),
    ...privateQueryPolicy(300_000),
  });
}
// Everyone with a profile, for the names on conversations.
export function usePeople() {
  return useQuery({
    queryKey: ["people"],
    queryFn: () => api<{ people: Person[] }>("/api/people"),
    ...privateQueryPolicy(300_000),
  });
}
// How a conversation's owner reads: "You" for the signed-in person.
export function useOwnerLabel() {
  const me = useMe().data?.email,
    people = usePeople().data?.people;
  return (owner: string) => (owner === me ? "You" : personName(people, owner));
}
// Whose conversations Today shows on this device: the signed-in person's
// until they ask for everyone's.
const EVERYONE_KEY = "projects.everyone";
export function savedEveryone() {
  try {
    return localStorage.getItem(EVERYONE_KEY) === "true";
  } catch {
    return false;
  }
}
export function saveEveryone(everyone: boolean) {
  try {
    localStorage.setItem(EVERYONE_KEY, String(everyone));
  } catch {
    /* A private window keeps the choice for this visit only. */
  }
}
// The choice as the views share it, kept on this device when it changes.
export function useEveryone() {
  const [everyone, setEveryone] = useState(savedEveryone);
  const choose = (value: boolean) => {
    saveEveryone(value);
    setEveryone(value);
  };
  return [everyone, choose] as const;
}
// Settings: the signed-in person's own name.
export function ProfilePanel() {
  const client = useQueryClient();
  const me = useMe();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (name: string) => api<Person>("/api/me", { name }),
    onSuccess: (person) => {
      client.setQueryData(["me"], person);
      void client.invalidateQueries({ queryKey: ["people"] });
      setDraft(null);
    },
  });
  const name = draft ?? me.data?.name ?? "";
  const changed =
    !!draft?.trim() && draft.trim() !== (me.data?.name ?? "");
  const error = save.error ?? me.error;
  return (
    <section className="profile" aria-label="You">
      <h2 className="section">You</h2>
      <form
        className="toolbar profile-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) save.mutate(draft!.trim());
        }}
      >
        <label>
          Name
          <input
            value={name}
            maxLength={NAME_LIMIT}
            disabled={!me.data || save.isPending}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="btn" disabled={!changed || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </form>
      <p className="subtle">
        {me.data ? `Signed in as ${me.data.email}. ` : ""}
        Your name is shown on the conversations you start; everyone who signs in
        sees everyone's.
      </p>
      {error && (
        <p role="alert" className="error">
          {error.message === "SIGN_IN"
            ? "Sign in again to see or change your name."
            : error.message}
        </p>
      )}
      {save.isSuccess && draft === null && (
        <p role="status" className="subtle">
          Saved.
        </p>
      )}
    </section>
  );
}
