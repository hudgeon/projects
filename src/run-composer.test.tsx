import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { archiveSnapshot } from "../worker/snapshot-fixtures";
import { Composer } from "./run-composer";

test("the owner's ordinary composer defaults to Investigate and exposes its repository picker", () => {
  function render(investigate: boolean, props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    const client = new QueryClient();
    client.setQueryData(["runs", null, false], {
      pages: [{runs: [], enabled: true, investigate, nextOffset: null}],
      pageParams: [0],
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Composer snapshots={[archiveSnapshot("studio")]} archives={[]} initialText="Check the evidence" {...props} />
      </QueryClientProvider>,
    );
  }

  const blank = render(true);
  assert.match(blank, /<option value="investigate" selected="">Investigate<\/option>/);
  assert.match(blank, /<option value="" selected="">Choose a repository<\/option>/);
  assert.match(blank, /type="submit" disabled="">Investigate<\/button>/);
  assert.match(render(true, {projectId: "acme/fixture"}), /type="submit">Investigate<\/button>/);
  assert.match(render(true, {projectId: "acme/removed"}), /type="submit" disabled="">Investigate<\/button>/);
  assert.match(render(false), /type="submit">Start<\/button>/);
  assert.match(render(true, {emailThread: "0123456789", submitLabel: "Start activity"}), /type="submit">Start activity<\/button>/);
  assert.match(render(true, {submitLabel: "Discuss"}), /type="submit">Discuss<\/button>/);
  assert.match(render(true, {submitLabel: "Start activity"}), /type="submit">Start activity<\/button>/);
});
