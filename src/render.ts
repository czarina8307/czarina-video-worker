import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderRequest, Segment } from "./types.js";
import { buildSrt } from "./srt.js";
import { downloadFromStorage, uploadToStorage, upsertOutputStatus } from "./supabase.js";
import { config } from "./config.js";

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1",
    file,
  ]);
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur)) throw new Error(`Konnte Videodauer nicht lesen: ${stdout}`);
  return dur;
}

async function downloadSegmentAudios(segments: Segment[], dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const res = await fetch(segments[i].audio_url);
    if (!res.ok) throw new Error(`TTS-Clip ${i} nicht ladbar (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const p = join(dir, `seg_${String(i).padStart(4, "0")}.wav`);
    await writeFile(p, buf);
    paths.push(p);
  }
  return paths;
}

async function buildLocalizedAudio(
  segments: Segment[],
  clipPaths: string[],
  durationSec: number,
  outWav: string,
): Promise<void> {
  const inputs = clipPaths.flatMap((p) => ["-i", p]);
  const labels: string[] = [];
  const chains: string[] = [];

  segments.forEach((seg, i) => {
    const ms = Math.max(0, Math.round(seg.start * 1000));
    chains.push(`[${i}:a]adelay=${ms}:all=1[a${i}]`);
    labels.push(`[a${i}]`);
  });

  let filter: string;
  if (segments.length === 1) {
    filter = `${chains[0]};[a0]apad=whole_dur=${durationSec}[out]`;
  } else {
    filter =
      `${chains.join(";")};` +
      `${labels.join("")}amix=inputs=${segments.length}:normalize=0:dropout_transition=0[mix];` +
      `[mix]apad=whole_dur=${durationSec}[out]`;
  }

  await execa("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[out]",
    "-ac", "2",
    "-ar", "48000",
    outWav,
  ]);
}

async function muxAudioOntoVideo(videoIn: string, audioIn: string, videoOut: string): Promise<void> {
  await execa("ffmpeg", [
    "-y",
    "-i", videoIn,
    "-i", audioIn,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    videoOut,
  ]);
}

export async function processRender(req: RenderRequest): Promise<void> {
  const outputBucket = req.output_bucket ?? config.defaultOutputBucket;
  const workDir = await mkdtemp(join(tmpdir(), `render-${req.lang}-`));

  try {
    await upsertOutputStatus(req.job_id, req.lang, { status: "rendering", error: null });

    const videoBuf = await downloadFromStorage(req.source_bucket, req.source_path);
    const videoIn = join(workDir, "source.mp4");
    await writeFile(videoIn, videoBuf);

    const duration = await probeDuration(videoIn);
    const clipPaths = await downloadSegmentAudios(req.segments, workDir);

    const audioWav = join(workDir, "localized.wav");
    await buildLocalizedAudio(req.segments, clipPaths, duration, audioWav);

    const videoOut = join(workDir, "out.mp4");
    await muxAudioOntoVideo(videoIn, audioWav, videoOut);

    const srtPath = join(workDir, "out.srt");
    await writeFile(srtPath, buildSrt(req.segments), "utf8");

    const videoDest = `${req.output_prefix}.mp4`;
    const srtDest = `${req.output_prefix}.srt`;
    await uploadToStorage(outputBucket, videoDest, videoOut, "video/mp4");
    await uploadToStorage(outputBucket, srtDest, srtPath, "application/x-subrip");

    await upsertOutputStatus(req.job_id, req.lang, {
      status: "done",
      video_path: videoDest,
      srt_path: srtDest,
      duration_sec: duration,
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertOutputStatus(req.job_id, req.lang, { status: "error", error: message }).catch(() => {});
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
