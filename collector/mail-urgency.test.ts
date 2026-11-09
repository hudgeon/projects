import { test } from "node:test";
import assert from "node:assert/strict";
import { urgentMail } from "./mail-urgency";

test("urgency rules detect explicit incidents and requests while ordinary notices stay in the queue", () => {
  const blank = () => "";
  assert.equal(urgentMail("Fwd: [Validation Failed] remittance mismatch", "", blank, []), true);
  assert.equal(urgentMail("Update", "Could you please confirm today?", blank, []), true);
  assert.equal(urgentMail("Update: not urgent", "Whenever you have time.", blank, []), false);
  assert.equal(urgentMail("Bill payment scheduled", "Take action now.", blank, []), false);
  assert.equal(urgentMail("Meeting notes", "Attached. If you have received this communication in error, please notify us immediately.", blank, []), false);
  assert.equal(urgentMail("Allowlisting", "We will start blocking this week. Any update?", blank, []), true);
  assert.equal(urgentMail("Urgent offer", "", blank, ["CATEGORY_PROMOTIONS"]), false);
});
