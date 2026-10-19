// Profiles: who may sign in, by name. One row per allowed address, kept in the
// portfolio beside the sessions, and the routes that read and change them.
import { readJson } from "./auth";
import { defaultName, nameInputSchema, NAME_LIMIT, type Person } from "../src/people-model";
import type { Portfolio } from "./index";

export class People {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS people(email TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL)",
    );
  }
  // Every allowed address is a person. A row appears at the first sign-in
  // after the address is allowed, named from the address until the person sets
  // a name; an address allowed no longer keeps its row, so what it started
  // still carries its name.
  sync(emails: string[], now = Date.now()) {
    for (const email of emails)
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO people(email,name,created) VALUES(?,?,?)",
        email,
        defaultName(email),
        now,
      );
  }
  get(email: string): Person {
    this.sync([email]);
    return this.storage.sql
      .exec<Person>("SELECT email,name FROM people WHERE email=?", email)
      .one();
  }
  rename(email: string, name: string): Person {
    this.sync([email]);
    this.storage.sql.exec("UPDATE people SET name=? WHERE email=?", name, email);
    return this.get(email);
  }
  list(): Person[] {
    return this.storage.sql
      .exec<Person>("SELECT email,name FROM people ORDER BY created,email")
      .toArray();
  }
}
type PeopleStore = Pick<DurableObjectStub<Portfolio>, "person" | "renamePerson" | "people" | "rate">;
// The signed-in person and everyone's profiles. A conversation browser's
// sign-in reads them as the owner it signed in as; browserMay() keeps the name
// change for a person's own sign-in. Machines never reach these routes.
export async function peopleRoutes(
  request: Request,
  store: PeopleStore,
  caller: string,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/people") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return Response.json({ people: await store.people() });
  }
  if (pathname !== "/api/me") return null;
  if (request.method === "GET") return Response.json(await store.person(caller));
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let input;
  try {
    input = nameInputSchema.parse(await readJson(request, 1024));
  } catch {
    return Response.json({ error: `Give a name of 1 to ${NAME_LIMIT} characters.` }, { status: 400 });
  }
  if (!(await store.rate(`me:${caller}`, 30, 3600_000)))
    return Response.json({ error: "Try again later." }, { status: 429 });
  return Response.json(await store.renamePerson(caller, input.name));
}
