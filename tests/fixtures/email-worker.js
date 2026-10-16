export { Conversation } from "../../worker/index";
import worker, { Portfolio as Base } from "../../worker/index";
// Fake email at the same boundary as OTP: the request environment. Persist
// attempts in the test object's storage so a restart cannot hide a send.
export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, {...env, EMAIL: {
      send(message) { return env.PORTFOLIOS.getByName(env.PORTFOLIO_ID).recordEmail(message); },
    }}, ctx);
  },
};
export class Portfolio extends Base {
  constructor(ctx, env) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fake_email(seq INTEGER PRIMARY KEY AUTOINCREMENT,message TEXT NOT NULL)");
    super(ctx, env);
  }
  recordEmail(message) {
    const {seq} = this.ctx.storage.sql.exec("INSERT INTO fake_email(message) VALUES(?) RETURNING seq", JSON.stringify(message)).one();
    return {messageId: `message-${seq}`};
  }
  sentEmails() {
    return this.ctx.storage.sql.exec("SELECT message FROM fake_email ORDER BY seq").toArray().map(row => JSON.parse(row.message));
  }
  seedBriefHistory() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS daily_review (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, published INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO daily_review VALUES(1,?,?)", "historical edition", Date.now());
  }
  briefHistory() {
    return this.ctx.storage.sql.exec("SELECT payload FROM daily_review").toArray().map(row => row.payload);
  }
}
