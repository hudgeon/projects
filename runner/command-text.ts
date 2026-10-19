import { credentialLike } from "./project-sources";

// A command as Jev may see it (owner's approval, 19 October 2026):
// recognizable credentials replaced and the length bounded. Null when
// something credential-like survives the replacement, so that command is not
// sent at all. Best effort: it never makes a command safe to publish.
export const COMMAND_CHARS = 2000;
const REDACTED = "[redacted]";
const rules: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|dp\.st\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    REDACTED,
  ],
  // user:password@ in any URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization headers and curl's -u user:password.
  [/(\bauthorization\s*:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, `$1${REDACTED}`],
  [/((?:\s-u|--user)\s+["']?[^\s"':]+:)[^\s"']+/g, `$1${REDACTED}`],
  // A secret-named key, variable or flag with a literal value; $NAME and
  // ${NAME} are references, not values.
  [
    /((?:^|[\s"'{,(;&|])-{0,2}["']?[\w.-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?(?:\s*[:=]\s*|\s+))(["']?)(?![$\s"'])[^\s"'&|;)]{6,}\2/gi,
    `$1$2${REDACTED}$2`,
  ],
];
// Bits per character: a random token scores near the log of its alphabet.
const entropy = (value: string) => {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((h, n) => h - (n / value.length) * Math.log2(n / value.length), 0);
};
const randomLooking = (value: string) =>
  value.length >= 16 && /[A-Za-z]/.test(value) && /\d/.test(value) && entropy(value) >= 3.5;
// Deny by default: a long, random-looking value given to any variable, flag
// or key is replaced, whatever its name or format.
const assigned =
  /((?:^|[\s;&|(])(?:[A-Za-z_]\w*=|--?[A-Za-z][\w-]*(?:=|\s+))|["']?[\w.-]+["']?\s*:\s*)(["']?)([\w+/=.:~-]{16,})\2/g;
export function commandForJev(command: string): string | null {
  // The whole command is redacted before the cut, so a secret across the
  // boundary is replaced whole and the cut only drops text.
  const text = rules
    .reduce((t, [rule, to]) => t.replace(rule, to), command)
    .replace(assigned, (all, lead: string, quote: string, value: string) =>
      randomLooking(value) ? `${lead}${quote}${REDACTED}${quote}` : all,
    );
  // Judged without the markers, which would otherwise read as a password.
  if (credentialLike(text.split(REDACTED).join(""))) return null;
  return text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS)}…` : text;
}
