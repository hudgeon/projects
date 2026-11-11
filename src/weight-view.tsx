import React from "react";
import { ago } from "./model";
import { kTokens, weightLabel, weightLine, type FrictionSnapshot } from "./friction-model";
// A machine's session weight beside its friction: the seven-day medians by
// app and source, then each day's. A machine that has stopped reporting
// shows what it last sent, and says when.
export const weightDays = (weight: NonNullable<FrictionSnapshot["weight"]>) =>
  [...new Set(weight.days.map((day) => day.date))]
    .sort()
    .reverse()
    .map((date) => ({
      date,
      line: weight.days
        .filter((day) => day.date === date && day.source !== "all")
        .map((day) => `${weightLabel(day)} ${kTokens(day.start)} / ${kTokens(day.peak)} (${day.sessions})`)
        .join(" · "),
    }));
export function Weight({ friction, stale, now }: { friction: FrictionSnapshot; stale: boolean; now: number }) {
  const weight = friction.weight;
  if (friction.state !== "ok" || !weight) return null;
  if (!weight.week.length)
    return <p className="subtle machine-note">Session weight, 7 days: no session with a model call.</p>;
  return (
    <details className="subtle machine-note">
      <summary>
        Session weight, 7 days{stale ? `, as reported ${ago(friction.observedAt, now)}` : ""}:{" "}
        {weight.week.map(weightLine).join(" · ")}
      </summary>
      <p>Median start / peak tokens (sessions), by the day a session was last active:</p>
      {weightDays(weight).map((day) => (
        <p key={day.date}>
          {day.date}: {day.line}
        </p>
      ))}
    </details>
  );
}
