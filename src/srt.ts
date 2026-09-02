import type { Segment } from "./types.js";

function toTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

export function buildSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const idx = i + 1;
      const time = `${toTimestamp(seg.start)} --> ${toTimestamp(seg.end)}`;
      return `${idx}\n${time}\n${seg.text.trim()}\n`;
    })
    .join("\n");
}
