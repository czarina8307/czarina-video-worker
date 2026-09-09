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

/** Baut eine SubRip-Datei. Segmente werden nach Startzeit sortiert; ein Ende vor dem Start wird auf Start+1s korrigiert. */
export function buildSrt(segments: Segment[]): string {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  return sorted
    .map((seg, i) => {
      const end = seg.end > seg.start ? seg.end : seg.start + 1;
      const time = `${toTimestamp(seg.start)} --> ${toTimestamp(end)}`;
      const text = seg.text.replace(/\r\n?/g, "\n").trim();
      return `${i + 1}\n${time}\n${text}\n`;
    })
    .join("\n");
}
