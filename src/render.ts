import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderRequest, RenderResult, Segment } from "./types.js";
import { buildSrt } from "./srt.js";
import { buildLocalizedAudio, muxAudioOntoVideo, probeDuration } from "./ffmpeg.js";
import { downloadToFile, uploadFile, upsertOutputStatus } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./log.js";

const CLIP_FETCH_TIMEOUT_MS = 60_000;

async function downloadSegmentAudios(segments: Segment[], dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const res = await fetch(segments[i].audio_url, { signal: AbortSignal.timeout(CLIP_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`TTS-Clip ${i} nicht ladbar (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error(`TTS-Clip ${i} ist leer`);
    // ffmpeg erkennt das Format am Inhalt, die Endung ist egal (wav/mp3/ogg …)
    const p = join(dir, `seg_${String(i).padStart(4, "0")}.audio`);
    await writeFile(p, buf);
    paths.push(p);
  }
  return paths;
}

async function notifyCallback(url: string | undefined, result: RenderResult): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn("Callback antwortete mit Fehler", { url, status: res.status });
  } catch (err) {
    log.warn("Callback nicht erreichbar", { url, error: String(err) });
  }
}

export async function processRender(req: RenderRequest): Promise<void> {
  const outputBucket = req.output_bucket ?? config.defaultOutputBucket;
  const workDir = await mkdtemp(join(tmpdir(), `render-${req.lang}-`));
  const startedAt = Date.now();
  const ctx = { job_id: req.job_id, lang: req.lang };
  const ffOpts = { timeout: config.renderTimeoutMs };

  try {
    await upsertOutputStatus(req.job_id, req.lang, { status: "rendering", error: null });
    log.info("Render gestartet", { ...ctx, segments: req.segments.length });

    const videoIn = join(workDir, "source.mp4");
    await downloadToFile(req.source_bucket, req.source_path, videoIn);

    const duration = await probeDuration(videoIn);
    const clipPaths = await downloadSegmentAudios(req.segments, workDir);

    const audioWav = join(workDir, "localized.wav");
    await buildLocalizedAudio(req.segments, clipPaths, duration, audioWav, ffOpts);

    const videoOut = join(workDir, "out.mp4");
    await muxAudioOntoVideo(videoIn, audioWav, duration, videoOut, ffOpts);

    const srtPath = join(workDir, "out.srt");
    await writeFile(srtPath, buildSrt(req.segments), "utf8");

    const videoDest = `${req.output_prefix}.mp4`;
    const srtDest = `${req.output_prefix}.srt`;
    await uploadFile(outputBucket, videoDest, videoOut, "video/mp4");
    await uploadFile(outputBucket, srtDest, srtPath, "application/x-subrip");

    await upsertOutputStatus(req.job_id, req.lang, {
      status: "done",
      video_path: videoDest,
      srt_path: srtDest,
      duration_sec: duration,
      error: null,
    });
    log.info("Render fertig", { ...ctx, duration_sec: duration, took_ms: Date.now() - startedAt });
    await notifyCallback(req.callback_url, { ...ctx, status: "done", video_path: videoDest, srt_path: srtDest, duration_sec: duration });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Render fehlgeschlagen", { ...ctx, error: message, took_ms: Date.now() - startedAt });
    await upsertOutputStatus(req.job_id, req.lang, { status: "error", error: message }).catch((e) =>
      log.error("Fehlerstatus konnte nicht gespeichert werden", { ...ctx, error: String(e) }),
    );
    await notifyCallback(req.callback_url, { ...ctx, status: "error", error: message });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
