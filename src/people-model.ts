import { z } from "zod";

// A person who may sign in: every allowed address is one. The name is theirs
// to set; until then it is read from the address. A name is one line of plain
// text: it is said in prompts and becomes helpers' Git author name, where a
// control character or angle bracket would break the identity line.
export type Person = { email: string; name: string };
export const NAME_LIMIT = 60;
const plainName = z
  .string()
  .trim()
  .min(1)
  .max(NAME_LIMIT)
  .regex(/^[^\p{Cc}<>]+$/u);
export const nameInputSchema = z.object({ name: plainName }).strict();
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
// A person as a claim hands them to a runner: the same plain name, and an
// address with nothing Git's author line could misread.
export const personSchema = z
  .object({
    email: z.string().trim().min(1).max(254).regex(/^[^\s<>]+$/),
    name: plainName,
  })
  .strict();
