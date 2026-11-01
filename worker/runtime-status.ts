import type { Portfolio } from "./index";
import { trace } from "./telemetry";
export async function runtimeStatus(store: DurableObjectStub<Portfolio>, env: Env, id?: string) {
  try {
    const versions = await trace("runtime.check", {}, () => store.runtimeVersions(id));
    const worker = env.CF_VERSION_METADATA?.id ?? "local";
    return {worker, portfolio: versions.portfolio, conversation: versions.conversation,
      ready: versions.portfolio === worker && versions.conversation === worker};
  } catch {
    return {ready: false};
  }
}
