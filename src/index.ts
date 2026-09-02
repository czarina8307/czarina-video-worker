import express from "express";
import { config } from "./config.js";
import { processRender } from "./render.js";
import type { RenderRequest } from "./types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== config.workerToken) return res.status(401).json({ error: "unauthorized" });
  next();
});

function validate(body: any): body is RenderRequest {
  return (
    body &&
    typeof body.job_id === "string" &&
    typeof body.lang === "string" &&
    typeof body.source_bucket === "string" &&
    typeof body.source_path === "string" &&
    typeof body.output_prefix === "string" &&
    Array.isArray(body.segments) &&
    body.segments.length > 0
  );
}

app.post("/render", (req, res) => {
  if (!validate(req.body)) return res.status(400).json({ error: "ungueltiger Request-Body" });
  const job = req.body as RenderRequest;

  res.status(202).json({ accepted: true, job_id: job.job_id, lang: job.lang });

  processRender(job).catch((err) => {
    console.error(`[render] ${job.job_id}/${job.lang} fehlgeschlagen:`, err);
  });
});

app.listen(config.port, () => {
  console.log(`Video-Worker lauscht auf Port ${config.port}`);
});
