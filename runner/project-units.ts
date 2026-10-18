import path from "node:path";

// Natural units of project text and their lexical ranking for a task.
const UNIT_CHARS = 1_200;
const SMALL_UNIT_CHARS = 160;
export type Excerpt = {
  path: string;
  section?: string;
  hash: string;
  startChar: number;
  endChar: number;
  text: string;
};
// Prior orders units the task's words do not reach: the work issue, the plan
// and files the task names, then the README are always candidates; other
// sources need a matching word.
export type Unit = Excerpt & { score: number; prior: number };
const STOP = new Set(
  "about above after again also and any are been before being below between both but can could did does doing done down during each few for from further had has have having here how into its itself just may might more most must not now off once only other our out over own same should some such than that the their them then there these they this those through too under until upon very was were what when where which while who why will with would yes you your".split(
    " ",
  ),
);
// Words split at camelCase and underscores; a trailing plural s is dropped.
const normal = (text: string) =>
  text
    .replace(/([a-z0-9])(?=[A-Z])/g, "$1 ")
    .replace(/_/g, " ")
    .toLowerCase();
const stem = (word: string) =>
  word.length > 4 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;
// The query's words by frequency; repetition marks a task's subject.
export function terms(text: string) {
  const counts = new Map<string, number>();
  for (const word of normal(text).match(/[a-z][a-z0-9]{2,}/g) ?? [])
    if (!STOP.has(word))
      counts.set(stem(word), (counts.get(stem(word)) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1]).slice(0, 128));
}
// Files the task names by path, or by a file name unique in the project.
export function named(query: string, files: string[]) {
  const names = new Map<string, number>();
  for (const file of files)
    names.set(
      path.posix.basename(file),
      (names.get(path.posix.basename(file)) ?? 0) + 1,
    );
  return new Set(
    files.filter((file) => {
      const base = path.posix.basename(file);
      return [
        file,
        ...(names.get(base) === 1 && base.includes(".") ? [base] : []),
      ].some((name) => {
        for (
          let i = query.indexOf(name);
          i >= 0;
          i = query.indexOf(name, i + 1)
        )
          if (
            !/[\w.-]/.test(query[i - 1] ?? "") &&
            !/\w/.test(query[i + name.length] ?? "")
          )
            return true;
        return false;
      });
    }),
  );
}

// BM25 over every unit, with the query's repeated words weighted up.
export function rank(pool: Unit[], words: Map<string, number>) {
  if (!words.size) return;
  const pattern = new RegExp(`\\b(${[...words.keys()].join("|")})s?\\b`, "g");
  const counts = pool.map((unit) => {
    const text = normal(`${unit.path} ${unit.section ?? ""} ${unit.text}`);
    const tf = new Map<string, number>();
    for (const [, word] of text.matchAll(pattern))
      tf.set(word, (tf.get(word) ?? 0) + 1);
    return { tf, length: text.length };
  });
  const df = new Map<string, number>();
  for (const { tf } of counts)
    for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  const average =
    counts.reduce((n, c) => n + c.length, 0) / Math.max(1, counts.length);
  pool.forEach((unit, i) => {
    const { tf, length } = counts[i];
    for (const [word, n] of tf) {
      const d = df.get(word)!,
        q = words.get(word)!;
      unit.score +=
        (((Math.log(1 + (pool.length - d + 0.5) / (d + 0.5)) * n * 2.2) /
          (n + 1.2 * (0.25 + (0.75 * length) / average))) *
          q *
          2.2) /
        (q + 1.2);
    }
  });
}

// Natural units: markdown sections at headings outside fences, and code's
// top-level statements, which start at column 0 after a blank or closing
// line. Small neighbours merge; long units split at paragraphs, then lines.
export function units(
  name: string,
  text: string,
  digest: string,
  prior: number,
  markdown = /\.mdx?$/i.test(name),
  label = "",
): Unit[] {
  const starts = [{ at: 0, section: label }];
  const headings: string[] = [];
  let at = 0,
    fence = "",
    previous = "";
  for (const line of text.split(/(?<=\n)/)) {
    const content = line.trimEnd();
    const marker = markdown
      ? /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1]
      : undefined;
    const heading = markdown
      ? /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(content)
      : null;
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (marker) fence = marker;
    else if (heading) {
      headings.length = heading[1].length;
      headings[heading[1].length - 1] = heading[2];
      const section = [label, ...headings].filter(Boolean).join(" > ");
      if (at) starts.push({ at, section });
      else starts[0].section = section;
    } else if (
      !markdown &&
      at &&
      /^[^\s\])}]/.test(content) &&
      (!previous.trim() || /^[\])}]/.test(previous))
    )
      starts.push({ at, section: label });
    at += line.length;
    previous = content;
  }
  const ranges: { start: number; end: number; section: string }[] = [];
  for (const [i, { at: start, section }] of starts.entries()) {
    const end = starts[i + 1]?.at ?? text.length,
      body = text.slice(start, end);
    // Imports carry no project knowledge an agent would act on.
    if (
      !body.trim() ||
      (!markdown &&
        /^\s*(?:import|from)\b/.test(body) &&
        body
          .split("\n")
          .every(
            (l) => !l.trim() || /^(?:import|from|export \*|[})]|\s)/.test(l),
          ))
    )
      continue;
    const last = ranges.at(-1);
    if (
      last &&
      last.end === start &&
      last.end - last.start < SMALL_UNIT_CHARS &&
      end - last.start <= UNIT_CHARS
    ) {
      last.end = end;
      // A heading with no text of its own introduces its first subsection.
      if (section.startsWith(last.section)) last.section = section;
    } else ranges.push({ start, end, section });
  }
  const result: Unit[] = [];
  for (const range of ranges)
    for (let s = range.start; s < range.end;) {
      let e = range.end;
      if (e - s > UNIT_CHARS) {
        const window = text.slice(s, s + UNIT_CHARS),
          paragraph = window.lastIndexOf("\n\n"),
          line = window.lastIndexOf("\n");
        e =
          s +
          (paragraph >= UNIT_CHARS / 3
            ? paragraph + 2
            : line >= UNIT_CHARS / 3
              ? line + 1
              : UNIT_CHARS);
      }
      // Offsets stay exact: only whole blank lines and trailing space go.
      let a = s,
        b = e;
      for (let nl; (nl = text.indexOf("\n", a)) >= 0 && nl < b; a = nl + 1)
        if (text.slice(a, nl).trim()) break;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a)
        result.push({
          path: name,
          ...(range.section ? { section: range.section } : {}),
          hash: digest,
          startChar: a,
          endChar: b,
          text: text.slice(a, b),
          score: 0,
          prior,
        });
      s = e;
    }
  return result;
}
