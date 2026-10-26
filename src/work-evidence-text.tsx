import React from "react";
export function EvidenceText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
        return m ? (
          <a key={i} href={m[2]} target="_blank" rel="noreferrer">
            {m[1]}
          </a>
        ) : (
          <React.Fragment key={i}>{part.replace(/\*\*/g, "")}</React.Fragment>
        );
      })}
    </>
  );
}
