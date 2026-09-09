import express from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { processRender } from "./render.js";
import { processExtract, type ExtractRequest } from "./extract.js";
import { RenderQueue } from "./queue.js";
import { log } from "./log.js";
import type { RenderRequest, Segment } from "./types.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // hinter Caddy
app.use(express.json({ limit: "5mb" }));

const queue = new RenderQueue(config.renderConcurrency);

app.get("/health", (_req, res) => res.json({ ok: true, ...queue.stats }));

// --- Auth: alles ausser /health braucht den Worker-Token -------------------
function tokenMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.workerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(token)) return res.status(401).json({ error: "unauthorized" });
  next();
});

// --- Validierung -----------------------------------------------------------
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

function isSegment(s: unknown): s is Segment {
  const x = s as Record<string, unknown>;
  return !!x && isNum(x.start) && isNum(x.end) && typeof x.text === "string" && isStr(x.audio_url)
    && /^https?:\/\//.test(x.audio_url);
}

function validate(body: unknown): string | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") return "Body fehlt";
  if (!isStr(b.job_id)) return "job_id fehlt";
  if (!isStr(b.lang) || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(b.lang)) return "lang ungültig (z.B. en, fr, de-CH)";
  if (!isStr(b.source_bucket)) return "source_bucket fehlt";
  if (!isStr(b.source_path) || !SAFE_PATH.test(b.source_path)) return "source_path ungültig";
  if (b.output_bucket !== undefined && !isStr(b.output_bucket)) return "output_bucket ungültig";
  if (!isStr(b.output_prefix) || !SAFE_PATH.test(b.output_prefix)) return "output_prefix ungültig";
  if (b.callback_url !== undefined && (!isStr(b.callback_url) || !/^https?:\/\//.test(b.callback_url))) return "callback_url ungültig";
  if (!Array.isArray(b.segments) || b.segments.length === 0) return "segments fehlen";
  if (b.segments.length > 2000) return "zu viele segments";
  const bad = (b.segments as unknown[]).findIndex((s) => !isSegment(s));
  if (bad >= 0) return `segments[${bad}] ungültig (start/end/text/audio_url)`;
  return null;
}

// --- Endpunkte -------------------------------------------------------------
app.post("/render", (req, res) => {
  const problem = validate(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const job = req.body as RenderRequest;

  const accepted = queue.enqueue(`${job.job_id}/${job.lang}`, () => processRender(job));
  if (!accepted) {
    return res.status(409).json({ error: "Dieser Job/Lang läuft bereits oder der Worker fährt herunter" });
  }
  log.info("Job angenommen", { job_id: job.job_id, lang: job.lang, ...queue.stats });
  res.status(202).json({ accepted: true, job_id: job.job_id, lang: job.lang, queue: queue.stats });
});

// Synchron: Tonspur fürs Transkribieren extrahieren (Antwort erst, wenn die Datei im Bucket liegt)
app.post("/extract-audio", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!isStr(b.source_bucket)) return res.status(400).json({ error: "source_bucket fehlt" });
  if (!isStr(b.source_path) || !SAFE_PATH.test(b.source_path)) return res.status(400).json({ error: "source_path ungültig" });
  if (b.output_bucket !== undefined && !isStr(b.output_bucket)) return res.status(400).json({ error: "output_bucket ungültig" });
  if (!isStr(b.output_path) || !SAFE_PATH.test(b.output_path)) return res.status(400).json({ error: "output_path ungültig" });
  try {
    const result = await processExtract(b as unknown as ExtractRequest);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Audio-Extraktion fehlgeschlagen", { source_path: b.source_path, error: message });
    res.status(500).json({ error: message });
  }
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { type?: string; message?: string };
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "ungültiges JSON" });
  if (e?.type === "entity.too.large") return res.status(413).json({ error: "Body zu gross" });
  log.error("Unbehandelter Fehler", { error: e?.message ?? String(err) });
  res.status(500).json({ error: "internal" });
});

// --- Start + sauberes Herunterfahren ----------------------------------------
const server = app.listen(config.port, () => {
  log.info("Video-Worker lauscht", { port: config.port, concurrency: config.renderConcurrency });
});

async function shutdown(signal: string) {
  log.info("Shutdown", { signal, ...queue.stats });
  server.close();
  await queue.drain(config.renderTimeoutMs);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
