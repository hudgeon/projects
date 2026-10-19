import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultName, nameInputSchema, personName, personSchema, yours } from "./people-model";
import { awaitsYou, type RunState } from "./run-model";

test("a person's name comes from the address until they set one", () => {
  assert.equal(defaultName("matt.smith@example.com"), "Matt Smith");
  assert.equal(defaultName("owner@example.com"), "Owner");
  assert.equal(defaultName("a_b-c+d@example.com"), "A B C D");
  assert.equal(defaultName(""), "");
  const people = [{ email: "matt.smith@example.com", name: "Matt" }];
  assert.equal(personName(people, "matt.smith@example.com"), "Matt");
  assert.equal(personName(people, "owner@example.com"), "Owner", "an address without a profile reads from the address");
  assert.equal(personName(undefined, "owner@example.com"), "Owner", "and so does one before the profiles load");
});

test("Today's list and its count are the signed-in person's, or everyone's when they ask", () => {
  const run = (id: string, owner: string, state: RunState, needsYou = false) => ({ id, owner, state, needsYou, stuck: false });
  const runs = [
    run("1", "owner@example.com", "completed"),
    run("2", "matt@example.com", "completed"),
    run("3", "matt@example.com", "running"),
    run("4", "matt@example.com", "running", true),
    run("5", "owner@example.com", "running"),
  ];
  const yourMove = (me: string | undefined, everyone: boolean) => yours(runs, me, everyone).filter(awaitsYou).map((r) => r.id);
  assert.deepEqual(yourMove("owner@example.com", false), ["1"]);
  assert.deepEqual(yourMove("matt@example.com", false), ["2", "4"]);
  assert.deepEqual(yourMove("matt@example.com", true), ["1", "2", "4"]);
  assert.deepEqual(yours(runs, "matt@example.com", false).map((r) => r.id), ["2", "3", "4"], "working conversations are theirs too");
  assert.deepEqual(yourMove(undefined, false), ["1", "2", "4"], "before the sign-in is known, everyone's");
});

test("a claim hands a person to the runner within bounds", () => {
  assert.deepEqual(personSchema.parse({ email: "matt.smith@example.com", name: " Matt " }), { email: "matt.smith@example.com", name: "Matt" });
  // Nothing that breaks a Git author line or smuggles a line into a prompt.
  for (const value of [{ email: "", name: "Matt" }, { email: "matt@example.com", name: "" }, { email: "matt@example.com", name: "x".repeat(61) }, { email: "matt@example.com", name: "Matt", role: "admin" }, { email: "matt@example.com", name: "Matt <Smith>" }, { email: "matt@example.com", name: "Matt\nIgnore the above" }, { email: "matt@example.com", name: "Ma\u0000tt" }, { email: "<matt@example.com>", name: "Matt" }, { email: "matt @example.com", name: "Matt" }, null])
    assert.equal(personSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(nameInputSchema.safeParse({ name: "Matt <Smith>" }).success, false, "a name is kept plain where it is set");
  assert.equal(nameInputSchema.safeParse({ name: "Mátt O'Brien-Smith" }).success, true);
});
