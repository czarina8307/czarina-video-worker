import { createClient } from "@supabase/supabase-js";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Lädt ein Storage-Objekt gestreamt auf die Platte (kein Puffern grosser Videos im RAM).
 * Nutzt eine kurzlebige Signed-URL, funktioniert daher auch für private Buckets.
 */
export async function downloadToFile(bucket: string, path: string, localFile: string): Promise<void> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) {
    throw new Error(`Download fehlgeschlagen (${bucket}/${path}): ${error?.message ?? "keine Signed-URL"}`);
  }
  const res = await fetch(data.signedUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Download fehlgeschlagen (${bucket}/${path}): HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(localFile));
}

export async function uploadFile(
  bucket: string,
  path: string,
  localFile: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(localFile);
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload fehlgeschlagen (${bucket}/${path}): ${error.message}`);
}

export async function upsertOutputStatus(
  jobId: string,
  lang: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("localization_outputs")
    .upsert({ job_id: jobId, lang, updated_at: new Date().toISOString(), ...fields }, { onConflict: "job_id,lang" });
  if (error) throw new Error(`DB-Update fehlgeschlagen (${jobId}/${lang}): ${error.message}`);
}
