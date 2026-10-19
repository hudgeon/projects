import { z } from "zod";

// A person who may sign in: every allowed address is one. The name is theirs
// to set; until then it is read from the address.
export type Person = { email: string; name: string };
export const NAME_LIMIT = 60;
export const nameInputSchema = z
  .object({ name: z.string().trim().min(1).max(NAME_LIMIT) })
  .strict();
// "matt.smith@example.com" reads as "Matt Smith" until Matt says otherwise.
export function defaultName(email: string) {
  return email
    .split("@")[0]
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, NAME_LIMIT);
}
// The name shown for an address: the profile's, or the default when the
// profiles have not loaded or no longer list it.
export function personName(people: Person[] | undefined, email: string) {
  return people?.find((person) => person.email === email)?.name ?? defaultName(email);
}
// The conversations a view shows as a person's: their own, or everyone's when
// they ask for everyone's or before their own sign-in is known.
export function yours<T extends { owner: string }>(
  runs: T[],
  me: string | undefined,
  everyone: boolean,
) {
  return everyone || !me ? runs : runs.filter((run) => run.owner === me);
}
