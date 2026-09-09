export interface Segment {
  /** Startzeit im Video in Sekunden */
  start: number;
  /** Endzeit im Video in Sekunden (nur für die .srt relevant) */
  end: number;
  /** Übersetzter Text (landet in der .srt) */
  text: string;
  /** Öffentlich (oder via Signed-URL) abrufbarer TTS-Clip: wav/mp3/ogg – ffmpeg erkennt das Format selbst */
  audio_url: string;
}

export interface RenderRequest {
  job_id: string;
  lang: string;
  source_bucket: string;
  source_path: string;
  output_bucket?: string;
  /** z.B. "jobs/<job_id>/en" -> es entstehen "<prefix>.mp4" und "<prefix>.srt" */
  output_prefix: string;
  segments: Segment[];
  /** Optional: wird nach Abschluss (done/error) per POST mit dem Ergebnis aufgerufen (z.B. n8n-Webhook) */
  callback_url?: string;
}

export type OutputStatus = "queued" | "rendering" | "done" | "error";

export interface RenderResult {
  job_id: string;
  lang: string;
  status: "done" | "error";
  video_path?: string;
  srt_path?: string;
  duration_sec?: number;
  error?: string;
}
