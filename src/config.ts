function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Ungültiger Wert für ${name}: ${raw}`);
  return n;
}

export const config = {
  port: optionalInt("PORT", 8080),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  workerToken: required("WORKER_TOKEN"),
  defaultOutputBucket: process.env.DEFAULT_OUTPUT_BUCKET ?? "video-localization",
  renderConcurrency: optionalInt("RENDER_CONCURRENCY", 1),
  renderTimeoutMs: optionalInt("RENDER_TIMEOUT_SEC", 1800) * 1000,
  mailPollIntervalMs: optionalInt("MAIL_POLL_INTERVAL_SEC", 60) * 1000,
};
