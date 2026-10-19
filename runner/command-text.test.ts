import { test } from "node:test";
import assert from "node:assert/strict";
import { commandForJev, COMMAND_CHARS } from "./command-text";

test("commands reach Jev with recognizable credentials replaced", () => {
  const cases: [string, string][] = [
    ["npm test", "npm test"],
    ["gh pr checks 117 --watch", "gh pr checks 117 --watch"],
    ['curl -H "Authorization: Bearer abcdef0123456789" https://api.example.com', 'curl -H "Authorization: Bearer [redacted]" https://api.example.com'],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "export GITHUB_TOKEN=[redacted]"],
    ["psql postgres://reader:hunter2hunter@db.example.com/app -c 'select 1'", "psql postgres://reader:[redacted]@db.example.com/app -c 'select 1'"],
    ["curl -u deploy:s3cretvalue https://example.com", "curl -u deploy:[redacted] https://example.com"],
    ["tool login --password hunter2hunter --user ops", "tool login --password [redacted] --user ops"],
    ['echo \'{"api_key": "abcd1234efgh"}\' > config.json', 'echo \'{"api_key": "[redacted]"}\' > config.json'],
    ["TOKEN=$TOKEN curl -H \"Authorization: Bearer $TOKEN\" https://x", "TOKEN=$TOKEN curl -H \"Authorization: Bearer [redacted]\" https://x"],
    ["DOPPLER_TOKEN=dp.st.prd.abcdefghijklmnopqrstuvwxyz doppler run -- node x.js", "DOPPLER_TOKEN=[redacted] doppler run -- node x.js"],
  ];
  for (const [command, sent] of cases) assert.equal(commandForJev(command), sent, command);
});

test("a command still credential-like after replacement is not sent, and a long one is bounded", () => {
  assert.equal(commandForJev("printf '%s' -----BEGIN PRIVATE KEY-----"), "printf '%s' [redacted]");
  assert.equal(commandForJev(`echo "password = 'correcthorsebattery'"`), `echo "password = '[redacted]'"`);
  // A passphrase with spaces escapes the replacement but not the final check.
  assert.equal(commandForJev(`echo 'password: "my long pass phrase"'`), null);
  const long = commandForJev(`echo ${"x".repeat(COMMAND_CHARS * 2)}`)!;
  assert.equal(long.length, COMMAND_CHARS + 1);
});

test("long random-looking values are replaced whatever their name or format, and a secret across the cut is replaced whole", () => {
  assert.equal(commandForJev("export SESSION=Zx8Kq2Lm9Pw4Rt7Ybn3 && run"), "export SESSION=[redacted] && run");
  assert.equal(commandForJev("tool --signature=f3A9kQ2mZ8pL4xR7tW1y"), "tool --signature=[redacted]");
  assert.equal(commandForJev('echo \'{"id": "Qm9vYmFyMTIzNDU2Nzg5MA"}\''), 'echo \'{"id": "[redacted]"}\'');
  for (const kept of ["git checkout -b feature-123", "npm run collector:build", "gh run watch 39183077667 --exit-status", "BRANCH=projects/fix-the-refresh-job npm test"])
    assert.equal(commandForJev(kept), kept, kept);
  const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3";
  const sent = commandForJev(`echo ${"x".repeat(COMMAND_CHARS - 12)} ${secret}`)!;
  assert.doesNotMatch(sent, /ghp_|a1B2/);
});
