import { execa, type Options as ExecaOptions } from "execa";
import type { Segment } from "./types.js";

/** Kürzt ffmpeg-Stderr auf die aussagekräftigen letzten Zeilen. */
function tail(text: string, lines = 15): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function run(bin: "ffmpeg" | "ffprobe", args: string[], opts: ExecaOptions = {}): Promise<string> {
  try {
    const { stdout } = await execa(bin, args, { ...opts, stdout: "pipe", stderr: "pipe" });
    return String(stdout ?? "");
  } catch (err: unknown) {
    const e = err as { stderr?: string; timedOut?: boolean; message?: string };
    if (e.timedOut) throw new Error(`${bin} hat das Zeitlimit überschritten`);
    throw new Error(`${bin} fehlgeschlagen:\n${tail(e.stderr ?? e.message ?? "")}`);
  }
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1",
    file,
  ]);
  const dur = parseFloat(out.trim());
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Konnte Videodauer nicht lesen: "${out}"`);
  return dur;
}

/**
 * Baut aus den TTS-Clips eine Tonspur exakt in Videolänge:
 * jeder Clip wird auf 48 kHz Stereo gebracht, um seg.start verschoben, alle werden gemischt,
 * mit Stille aufgefüllt und auf die Videodauer gekappt.
 */
export function buildAudioFilter(segments: Segment[], durationSec: number): string {
  const chains = segments.map((seg, i) => {
    const ms = Math.max(0, Math.round(seg.start * 1000));
    return `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}:all=1[a${i}]`;
  });
  const labels = segments.map((_, i) => `[a${i}]`).join("");
  const tailFilter = `apad=whole_dur=${durationSec},atrim=0:${durationSec},asetpts=PTS-STARTPTS[out]`;

  if (segments.length === 1) return `${chains[0]};[a0]${tailFilter}`;
  return (
    `${chains.join(";")};` +
    `${labels}amix=inputs=${segments.length}:normalize=0:dropout_transition=0[mix];` +
    `[mix]${tailFilter}`
  );
}

export async function buildLocalizedAudio(
  segments: Segment[],
  clipPaths: string[],
  durationSec: number,
  outWav: string,
  opts: ExecaOptions = {},
): Promise<void> {
  if (segments.length !== clipPaths.length) throw new Error("Segment-/Clip-Anzahl stimmt nicht überein");
  const inputs = clipPaths.flatMap((p) => ["-i", p]);
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-y",
      ...inputs,
      "-filter_complex", buildAudioFilter(segments, durationSec),
      "-map", "[out]",
      "-ac", "2",
      "-ar", "48000",
      "-c:a", "pcm_s16le",
      outWav,
    ],
    opts,
  );
}

/** Video-Stream unverändert kopieren, neue Tonspur als AAC einmuxen, auf Videolänge kappen. */
export async function muxAudioOntoVideo(
  videoIn: string,
  audioIn: string,
  durationSec: number,
  videoOut: string,
  opts: ExecaOptions = {},
): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-y",
      "-i", videoIn,
      "-i", audioIn,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", String(durationSec),
      "-movflags", "+faststart",
      videoOut,
    ],
    opts,
  );
}
