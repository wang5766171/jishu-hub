import type { Session, Message, SessionSearchResult } from "@/types";

function extractPreviewText(message: Message, q: string): string {
  for (const block of message.content) {
    if (block.type === "text") {
      const text = block.text;
      const idx = text.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 20);
        const end = Math.min(text.length, idx + q.length + 40);
        return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
      }
    }
  }
  return "";
}

export function searchSessions(sessions: Session[], query: string): SessionSearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  const results: SessionSearchResult[] = [];

  for (const session of sessions) {
    let matchCount = 0;
    let firstMatchIndex = -1;
    let previewText = "";

    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i];
      let messageHasMatch = false;

      for (const block of message.content) {
        if (block.type === "text") {
          const m = block.text.match(regex);
          if (m && m.length > 0) {
            matchCount += m.length;
            messageHasMatch = true;
          }
        }
      }

      if (messageHasMatch && firstMatchIndex === -1) {
        firstMatchIndex = i;
        previewText = extractPreviewText(message, q);
      }
    }

    if (matchCount > 0) {
      results.push({
        sessionId: session.id,
        matchCount,
        previewText: previewText.slice(0, 120),
        firstMatchIndex,
      });
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount);
}
