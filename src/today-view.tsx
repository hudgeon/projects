import { Link, useNavigate } from "@tanstack/react-router";
import type { Snapshot } from "./model";
import type { Close } from "./work-model";
import type { ArchiveEntry } from "./archive-model";
import { awaitsYou, type RunSummary } from "./run-model";
import { yours } from "./people-model";
import { usePeople } from "./people-view";
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
import { chatSearch, conversationSearch, workSearch, type Navigation } from "./navigation";
import { ChatDetail, ChatHealth, ChatRow, useChats } from "./chat-view";
import { chatsToDo, type ChatView } from "./chat-model";

// Today's count: the conversations waiting on the person, as the list shows
// them, and the Slack and Teams items that need them.
export function useWaiting(me: string | undefined, everyone: boolean) {
  const runs = useRuns().data?.pages.flatMap((page) => page.runs) ?? [];
  return yours(runs, me, everyone).filter(awaitsYou).length + chatsToDo(useChats().data).length;
}

// One place to work: start things, see what needs you and what is running,
// and keep the bigger work in view. On a phone a selected conversation takes
// the whole screen; on a desktop it opens beside the list. The list is the
// signed-in person's conversations until they ask for everyone's.
export function TodayView({
  snapshots,
  archives,
  closes,
  navigation,
  now,
  me,
  everyone,
  onEveryone,
}: {
  snapshots: Snapshot[];
  archives: ArchiveEntry[];
  closes: Close[];
  navigation: Navigation;
  now: number;
  me?: string;
  everyone: boolean;
  onEveryone: (everyone: boolean) => void;
}) {
  const navigate = useNavigate({ from: "/" });
  const done = !!navigation.archived;
  const list = useRuns(navigation.project, done);
  // Bigger work counts every current conversation, whatever the filter.
  const current = useRuns();
  const all = current.data?.pages.flatMap((page) => page.runs) ?? [];
  const runs = yours(
    list.data?.pages.flatMap((page) => page.runs) ?? [],
    me,
    everyone,
  );
  // Slack and Teams items that need the person join Your move, unless a
  // project filters the list; they belong to no project.
  const chatItems = chatsToDo(useChats().data);
  const chats = done || navigation.project ? [] : chatItems;
  const chatAt = chats.findIndex((item) => item.key === navigation.chat);
  const nextChat = chatAt >= 0 ? (chats[chatAt + 1] ?? chats[chatAt - 1]) : undefined;
  // The switch appears once more than one person has a profile.
  const people = usePeople().data?.people ?? [];
  const names = projectNames(snapshots, archives);
  const selected = navigation.run;
  const rank = (run: RunSummary) =>
    urgency(run.needsYou || run.stuck ? "blocked" : run.state);
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
  const section = (title: string, items: RunSummary[], empty?: string, chatRows: ChatView[] = []) =>
    items.length || chatRows.length || empty ? (
      <section className="queue-section" aria-label={title}>
        <h2>
          {title}{" "}
          {!!(items.length + chatRows.length) && (
            <span className="count">{items.length + chatRows.length}</span>
          )}
        </h2>
        {items.length || chatRows.length ? (
          <div className="rows">
            {chatRows.map((item) => (
              <ChatRow
                key={item.key}
                item={item}
                search={chatSearch(item.key, navigation.project)}
                selected={item.key === navigation.chat}
              />
            ))}
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
    <div className={`today${selected || navigation.work || navigation.chat ? " has-run" : ""}`}>
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
        {people.length > 1 && (
          <div className="filters scope" role="group" aria-label="Whose conversations">
            <button
              type="button"
              className={everyone ? "" : "selected"}
              aria-pressed={!everyone}
              onClick={() => onEveryone(false)}
            >
              Yours
            </button>
            <button
              type="button"
              className={everyone ? "selected" : ""}
              aria-pressed={everyone}
              onClick={() => onEveryone(true)}
            >
              Everyone
            </button>
          </div>
        )}
        {!done && <ChatHealth now={now} />}
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
            {section(
              "Your move",
              yourMove,
              everyone ? "Nothing waiting on anyone." : "Nothing waiting on you.",
              chats,
            )}
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
        ) : navigation.chat ? (
          <ChatDetail
            key={navigation.chat}
            chatKey={navigation.chat}
            snapshots={snapshots}
            archives={archives}
            back={conversationSearch(undefined, navigation.project)}
            next={nextChat ? chatSearch(nextChat.key, navigation.project) : undefined}
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
