import type { ReactNode } from "react";

// Formatting is rendered as React text nodes; model output never becomes HTML.
export default function AssistantText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const tokens = /```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*|__[^_]+__/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index!;
    if (index > start) parts.push(text.slice(start, index));
    const token = match[0];
    if (token.startsWith("```")) {
      const body = token.slice(3, -3).replace(/^[\w#+.-]*\r?\n/, "");
      parts.push(
        <pre key={index}>
          <code>{body}</code>
        </pre>,
      );
    } else if (token.startsWith("`")) {
      parts.push(<code key={index}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    }
    start = index + token.length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return <>{parts}</>;
}
