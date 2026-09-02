export interface Segment {
  start: number;
  end: number;
  text: string;
  audio_url: string;
}

export interface RenderRequest {
  job_id: string;
  lang: string;
  source_bucket: string;
  source_path: string;
  output_bucket?: string;
  output_prefix: string;
  segments: Segment[];
}
