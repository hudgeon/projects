import { Link, useNavigate } from "@tanstack/react-router";
import type { Snapshot } from "./model";
import type { Close } from "./work-model";
import type { ArchiveEntry } from "./archive-model";
import { awaitsYou, type RunSummary } from "./run-model";
import {
  Composer,
  ConversationPage,
  ConversationRow,
  errorText,
  projectNames,
  urgency,
  useRuns,
} from "./run-view";
import { BiggerWork, WorkDetail } from "./work-view";
import { conversationSearch, workSearch, type Navigation } from "./navigation";

// One place to work: start things, see what needs you and what is running,
// and keep the bigger work in view. On a phone a selected conversation takes
// the whole screen; on a desktop it opens beside the list.
export function TodayView({
  snapshots,
  archives,
  closes,
  navigation,
  now,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  closes: Close[];
  navigation: Navigation;
  now: number;
}) {
  const navigate = useNavigate({ from: "/" });
  const done = !!navigation.archived;
  const list = useRuns(navigation.project, done);
  // Bigger work counts every current conversation, whatever the filter.
  const current = useRuns();
  const all = current.data?.pages.flatMap((page) => page.runs) ?? [];
  const runs = list.data?.pages.flatMap((page) => page.runs) ?? [];
  const names = projectNames(snapshots, archives);
  const selected = navigation.run;
  const rank = (run: RunSummary) =>
    urgency(run.needsYou ? "blocked" : run.state);
  const yourMove = runs
    .filter(awaitsYou)
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const working = runs.filter((run) => !awaitsYou(run));
  const search = (run?: RunSummary) =>
    navigation.work && (!run || run.workIssue === navigation.work)
      ? workSearch(navigation.work, navigation.email, run?.id)
      : conversationSearch(run?.id, navigation.project, done || undefined);
  // After Done, move straight on to the next thing waiting on the owner.
  const position = yourMove.findIndex((run) => run.id === selected);
  const next =
    position >= 0
      ? (yourMove[position + 1] ?? yourMove[position - 1])
      : undefined;
  const projectName = navigation.project
    ? (names.get(navigation.project) ?? navigation.project)
    : null;
  const section = (title: string, items: RunSummary[], empty?: string) =>
    items.length || empty ? (
      <section className="queue-section" aria-label={title}>
        <h2>
          {title}{" "}
          {!!items.length && <span className="count">{items.length}</span>}
        </h2>
        {items.length ? (
          <div className="rows">
            {items.map((run) => (
              <ConversationRow
                key={run.id}
                run={run}
                names={names}
                search={search(run)}
                selected={run.id === selected}
              />
            ))}
          </div>
        ) : (
          <p className="subtle">{empty}</p>
        )}
      </section>
    ) : null;
  return (
    <div className={`today${selected || navigation.work ? " has-run" : ""}`}>
      <aside className="today-queue" aria-label="Your conversations">
        {projectName && (
          <p className="filter-chip">
            Showing {projectName}
            <Link
              to="/"
              search={conversationSearch(
                selected,
                undefined,
                done || undefined,
              )}
              aria-label="Show all projects"
            >
              ✕
            </Link>
          </p>
        )}
        {!done && !navigation.work && (
          <Composer
            snapshots={snapshots}
            archives={archives}
            projectId={navigation.project}
            onStarted={(run) =>
              void navigate({
                to: "/",
                search: conversationSearch(run.id, navigation.project),
              })
            }
          />
        )}
        {list.error && (
          <p role="alert" className="error">
            {errorText(list.error)}
          </p>
        )}
        {list.isPending ? (
          <p className="subtle">Loading conversations…</p>
        ) : done ? (
          section("Done", runs, "Nothing marked Done yet.")
        ) : (
          <>
            {section("Your move", yourMove, "Nothing waiting on you.")}
            {section("Working", working)}
          </>
        )}
        {list.hasNextPage && (
          <button
            className="btn-quiet"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </button>
        )}
        <Link
          className="queue-switch"
          to="/"
          search={conversationSearch(
            undefined,
            navigation.project,
            done ? undefined : true,
          )}
        >
          {done ? "← Current conversations" : "Done conversations"}
        </Link>
      </aside>
      <div className="today-main">
        {selected ? (
          <ConversationPage
            key={selected}
            id={selected}
            snapshots={snapshots}
            archives={archives}
            back={search()}
            next={next ? search(next) : undefined}
          />
        ) : navigation.work ? (
          <WorkDetail
            number={navigation.work}
            emailThread={navigation.email}
            snapshots={snapshots}
            archives={archives}
            closes={closes}
            conversations={all}
            now={now}
          />
        ) : (
          <>
            <BiggerWork
              snapshots={snapshots}
              archives={archives}
              closes={closes}
              conversations={all}
              now={now}
            />
          </>
        )}
      </div>
    </div>
  );
}
