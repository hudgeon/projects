import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCUMENT_CSP,
  DOCUMENT_SANDBOX,
  MAX_DOCUMENT_BYTES,
  htmlSource,
  runnerDocumentSchema,
  sourceKey,
  sourceUrl,
} from "../src/document-model";
import { readDocument } from "../runner/documents";
import { parseNavigation } from "../src/navigation";

const sha = "463194f82f6b28aae058500959326d89bd6fb2a4";
const page = `https://github.com/acme/notes/blob/${sha}/guides/slides/deck%20one.html`;

test("only a committed HTML file on GitHub opens as a document", () => {
  assert.deepEqual(htmlSource(`${page}#L24`), {
    repo: "acme/notes",
    commit: sha,
    path: "guides/slides/deck one.html",
  });
  assert.equal(htmlSource(page.replace(sha, sha.toUpperCase()))?.commit, sha);
  assert.equal(sourceUrl(htmlSource(page)!), page);
  assert.equal(
    sourceKey(htmlSource(page.replace("acme/notes", "Acme/notes"))!),
    sourceKey(htmlSource(page)!),
  );
  for (const url of [
    `https://github.com/acme/notes/blob/main/guides/deck.html`,
    `https://github.com/acme/notes/tree/${sha}/guides/deck.html`,
    `https://github.com/acme/notes/blob/${sha}/guides/deck.md`,
    `https://github.com/acme/notes/blob/${sha}/guides/deck.html.png`,
    `http://github.com/acme/notes/blob/${sha}/deck.html`,
    `https://raw.githubusercontent.com/acme/notes/${sha}/deck.html`,
    `https://user:pass@github.com/acme/notes/blob/${sha}/deck.html`,
    `https://github.com:8443/acme/notes/blob/${sha}/deck.html`,
    `https://github.com/acme/notes/blob/${sha}/../secrets/deck.html`,
    `https://github.com/acme/notes/blob/${sha}/%2e%2e/deck.html`,
    `https://github.com/acme/notes/blob/${sha}/a%5Cb.html`,
    `https://github.com/acme/notes/blob/${sha}/a%00.html`,
    `https://github.com/acme/notes/blob/${sha}//deck.html`,
    `https://github.com/acme/notes/blob/${sha}/%E0%A4%A.html`,
    `https://github.com/acme/notes/blob/${sha}/${"a/".repeat(200)}deck.html`,
    `https://github.com/acme/blob/${sha}/deck.html`,
    "not a url",
  ])
    assert.equal(htmlSource(url), null, url);
});

test("a document opens over the current view only by a valid link", () => {
  assert.equal(parseNavigation({ view: "today", doc: page }).doc, page);
  const other = parseNavigation({
    view: "today",
    run: "4a3f0b8e-58b9-4e1d-9a52-1a0d9e7d3c11",
    doc: "https://example.com/deck.html",
  });
  assert.equal(other.doc, undefined);
  assert.equal(other.run, "4a3f0b8e-58b9-4e1d-9a52-1a0d9e7d3c11");
});

test("rendered HTML runs only in its own opaque origin, without network, forms or top navigation", () => {
  const tokens = DOCUMENT_SANDBOX.split(" ");
  for (const forbidden of [
    "allow-same-origin",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-forms",
    "allow-modals",
    "allow-downloads",
  ])
    assert.ok(!tokens.includes(forbidden), forbidden);
  const directives = new Map(
    DOCUMENT_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]),
  );
  assert.deepEqual(directives.get("sandbox"), tokens);
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(directives.get("script-src"), ["'unsafe-inline'"]);
  assert.deepEqual(directives.get("connect-src"), ["'none'"]);
  assert.deepEqual(directives.get("form-action"), ["'none'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'self'"]);
  assert.deepEqual(directives.get("img-src"), ["data:", "blob:"]);
});

test("a machine reads one edition through its GitHub login and reports fixed failures", async () => {
  const job = {
    id: "b".repeat(64),
    lease: "7c1f6a2e-3d4b-4c5d-8e9f-0a1b2c3d4e5f",
    repo: "acme/notes",
    commit: sha,
    path: "guides/slides/deck one.html",
  };
  let asked: string[] = [];
  const result = await readDocument(job, async (args) => {
    asked = args;
    return Buffer.from("<!doctype html><p>Deck</p>");
  });
  assert.deepEqual(asked, [
    "api",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/acme/notes/contents/guides/slides/deck%20one.html?ref=${sha}`,
  ]);
  assert.equal(Buffer.from((result as { content: string }).content, "base64").toString(), "<!doctype html><p>Deck</p>");
  assert.deepEqual(runnerDocumentSchema.safeParse({ runnerId: "4a3f0b8e-58b9-4e1d-9a52-1a0d9e7d3c11", id: job.id, lease: job.lease, ...result }).success, true);
  const fails = (error: object) => readDocument(job, async () => { throw Object.assign(new Error("private detail"), error); });
  assert.deepEqual(await fails({ stderr: "gh: Not Found (HTTP 404)" }), { failure: "not_found" });
  assert.deepEqual(await fails({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), { failure: "too_large" });
  assert.deepEqual(await fails({ stderr: "dial tcp: lookup api.github.com" }), { failure: "unavailable" });
  assert.deepEqual(await readDocument(job, async () => Buffer.from([60, 0, 62])), { failure: "not_html" });
  assert.deepEqual(await readDocument(job, async () => Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 32)), { failure: "too_large" });
  // Nothing outside a committed HTML file is read, whatever the request says.
  for (const path of ["../../../user/keys.html", "guides/../../x.html", "guides/deck.md", "a\\b.html"])
    assert.deepEqual(await readDocument({ ...job, path }, async () => assert.fail("read")), { failure: "not_found" }, path);
  // A report carries content or a failure, never both or neither.
  for (const body of [{}, { content: "AA==", failure: "not_found" }, { content: "not base64!" }])
    assert.equal(runnerDocumentSchema.safeParse({ runnerId: "4a3f0b8e-58b9-4e1d-9a52-1a0d9e7d3c11", id: job.id, lease: job.lease, ...body }).success, false);
  assert.equal(runnerDocumentSchema.safeParse({ runnerId: "4a3f0b8e-58b9-4e1d-9a52-1a0d9e7d3c11", id: job.id, content: "AA==" }).success, false, "a delivery names its lease");
});
