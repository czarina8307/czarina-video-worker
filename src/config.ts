function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  workerToken: required("WORKER_TOKEN"),
  defaultOutputBucket: process.env.DEFAULT_OUTPUT_BUCKET ?? "video-localization",
};
