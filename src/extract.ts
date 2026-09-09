import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAudio, probeDuration } from "./ffmpeg.js";
import { downloadToFile, uploadFile } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./log.js";

export interface ExtractRequest {
  source_bucket: string;
  source_path: string;
  output_bucket?: string;
  /** Zielpfad der Tondatei im Bucket, z.B. "jobs/<job_id>/audio.mp3" */
  output_path: string;
}

export interface ExtractResult {
  audio_bucket: string;
  audio_path: string;
  duration_sec: number;
  bytes: number;
}

/** Synchron: Video laden, Tonspur extrahieren, hochladen. Dauert wenige Sekunden pro Videominute. */
export async function processExtract(req: ExtractRequest): Promise<ExtractResult> {
  const outputBucket = req.output_bucket ?? config.defaultOutputBucket;
  const workDir = await mkdtemp(join(tmpdir(), "extract-"));
  const startedAt = Date.now();
  try {
    const videoIn = join(workDir, "source.mp4");
    await downloadToFile(req.source_bucket, req.source_path, videoIn);
    const duration = await probeDuration(videoIn);

    const audioOut = join(workDir, "audio.mp3");
    await extractAudio(videoIn, audioOut, { timeout: config.renderTimeoutMs });
    const bytes = (await stat(audioOut)).size;

    await uploadFile(outputBucket, req.output_path, audioOut, "audio/mpeg");
    log.info("Audio extrahiert", { source: req.source_path, duration_sec: duration, bytes, took_ms: Date.now() - startedAt });
    return { audio_bucket: outputBucket, audio_path: req.output_path, duration_sec: duration, bytes };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
