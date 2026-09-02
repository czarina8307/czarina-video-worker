import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

export async function downloadFromStorage(bucket: string, path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Download fehlgeschlagen (${bucket}/${path}): ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadToStorage(
  bucket: string,
  path: string,
  localFile: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(localFile);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload fehlgeschlagen (${bucket}/${path}): ${error.message}`);
}

export async function upsertOutputStatus(
  jobId: string,
  lang: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("localization_outputs")
    .upsert({ job_id: jobId, lang, ...fields }, { onConflict: "job_id,lang" });
  if (error) throw new Error(`DB-Update fehlgeschlagen (${jobId}/${lang}): ${error.message}`);
}
