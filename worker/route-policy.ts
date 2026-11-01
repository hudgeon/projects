// Routes authorised by the collector token; every other route needs a session.
export const collectorRoutes = new Set(["/api/ingest", "/api/closes", "/api/inbox/actions", "/api/review", "/api/collector/duties", "/api/chats/read", "/api/support/ack"]);
export const runnerRoutes = new Set(["/api/runner/claim", "/api/runner/heartbeat", "/api/runner/report", "/api/runner/screenshot", "/api/runner/readiness", "/api/runner/browser", "/api/runner/document"]);
// An owner's HTML edition, served only to their signed-in session.
export const documentPath = /^\/api\/documents\/([a-f0-9]{64})$/;
