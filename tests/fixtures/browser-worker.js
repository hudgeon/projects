export { default, Portfolio } from "../../worker/index";
import { Conversation as Base } from "../../worker/runs";
export class Conversation extends Base {
  constructor(ctx, env) {
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS fake_provider(id TEXT PRIMARY KEY,payload TEXT)",
    );
    const read = (key) =>
      JSON.parse(
        sql
          .exec("SELECT payload FROM fake_provider WHERE id=?", key)
          .toArray()[0]?.payload ?? "null",
      );
    const save = (key, value) =>
      sql.exec(
        "INSERT OR REPLACE INTO fake_provider VALUES(?,?)",
        key,
        JSON.stringify(value),
      );
    const connections = [];
    super(ctx, {
      ...env,
      BROWSER_HOSTS: "projects.example.com, mockups.example.net",
      BROWSER: {
        async acquire(options) {
          const count = (read("acquisitions") ?? 0) + 1;
          save("acquisitions", count);
          save("options", options);
          if (read("failAcquire")) {
            save("failAcquire", false);
            throw Error("provider secret must not leak");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
          const sessionId = "provider-" + count;
          save(sessionId, { sessionId });
          return { sessionId };
        },
        async getSession(id) {
          if (read("missingSession")) throw Error("BrowserBindingError: Session not found (status=404)");
          if (read("failLookup")) throw Error("BrowserBindingError: Unauthorized (status=403)");
          return read(id);
        },
        async connectSession(id) {
          return {
            webSocket: {
              fetch: async () => {
                const pair = new WebSocketPair();
                pair[1].accept();
                connections.push(pair[1]);
                pair[1].addEventListener("message", (event) =>
                  pair[1].send(event.data),
                );
                return new Response(null, { status: 101, webSocket: pair[0] });
              },
            },
          };
        },
        async closeSession(id) {
          save("closeAttempts", (read("closeAttempts") ?? 0) + 1);
          if (read("failClose")) throw Error("provider private details");
          save(id, null);
          save("closed", (read("closed") ?? 0) + 1);
          for (const socket of connections) {
            try {
              socket.close(1000, "closed");
            } catch {}
          }
          return { status: "closed" };
        },
        async getLiveView(id, options) {
          save("view", options);
          return {
            devtoolsFrontendUrl:
              "https://browser.example/live?token=private-view-token",
          };
        },
      },
    });
    this.testStorage = ctx.storage;
    this.readProvider = read;
    this.saveProvider = save;
  }
  inspectProvider() {
    return {
      acquisitions: this.readProvider("acquisitions"),
      closed: this.readProvider("closed"),
      closeAttempts: this.readProvider("closeAttempts"),
      options: this.readProvider("options"),
      view: this.readProvider("view"),
    };
  }
  failProvider(operation, enabled = true) {
    this.saveProvider(operation, enabled);
  }
  expireBrowser() {
    const row = this.testStorage.sql
      .exec("SELECT payload FROM browser_session")
      .one();
    const session = JSON.parse(row.payload);
    session.expires = Date.now() - 1;
    this.testStorage.sql.exec(
      "UPDATE browser_session SET payload=?",
      JSON.stringify(session),
    );
  }
  retryCleanup() {
    this.testStorage.sql.exec("UPDATE browser_session SET payload=json_set(payload,'$.retryAt',0)");
  }
  triggerAlarm() {
    return super.alarm();
  }
}
