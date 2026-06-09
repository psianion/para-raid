import { openSync, readSync, closeSync, statSync } from "fs";

const CHUNK_SIZE = 65536;

export function getLastAssistantText(transcriptPath: string, fromOffset?: number): string | null {
  let stat;
  try { stat = statSync(transcriptPath); } catch { return null; }
  if (stat.size === 0) return null;

  const fd = openSync(transcriptPath, "r");
  try {
    const startPos = fromOffset ?? Math.max(0, stat.size - CHUNK_SIZE);
    const readLen = stat.size - startPos;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, startPos);

    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"type":"assistant"')) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
            return parsed.message.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join("\n") || null;
          }
        } catch { continue; }
      }
    }

    if (startPos > 0 && fromOffset === undefined) {
      return getLastAssistantText(transcriptPath, 0);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function getNewContentSinceOffset(transcriptPath: string, offset: number): { text: string; newOffset: number } {
  let stat;
  try { stat = statSync(transcriptPath); } catch { return { text: "", newOffset: offset }; }
  if (stat.size <= offset) return { text: "", newOffset: offset };

  const fd = openSync(transcriptPath, "r");
  try {
    const readLen = stat.size - offset;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, offset);
    return { text: buf.toString("utf-8"), newOffset: stat.size };
  } finally {
    closeSync(fd);
  }
}
