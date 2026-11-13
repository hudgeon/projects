import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, privateQueryPolicy } from "./overview-query";
import type { RunSummary } from "./run-model";

type RunPage = {
  runs: RunSummary[];
  enabled: boolean;
  investigate?: boolean;
  nextOffset: number | null;
};
export function useRuns(projectId?: string, archived = false) {
  return useInfiniteQuery({
    queryKey: ["runs", projectId ?? null, archived],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        archived: String(archived),
        offset: String(pageParam),
      });
      if (projectId) params.set("projectId", projectId);
      return api<RunPage>(`/api/runs?${params}`);
    },
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    // Done conversations change rarely; current ones show live status.
    ...privateQueryPolicy(archived ? 30_000 : 5000),
  });
}
// Every conversation started from an email, current or Done, for the inbox.
export function useEmailConversations() {
  return useQuery({
    queryKey: ["runs", "email"],
    queryFn: () => api<RunPage>("/api/runs?email=true"),
    ...privateQueryPolicy(15_000),
  });
}
