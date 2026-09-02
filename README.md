# Czarina Video-Worker

Render-Worker für die Video-Lokalisierung: ersetzt die deutsche Tonspur einer
Bildschirmaufnahme durch eine übersetzte Stimme und liefert Video + .srt je
Sprache. Läuft auf Railway, spricht Supabase (Storage + DB). Kein Lip-Sync.

## Endpunkt
POST /render  (Header: Authorization: Bearer <WORKER_TOKEN>)
Antwort sofort 202; Fortschritt landet in Tabelle localization_outputs.
GET /health -> { ok: true }

## Railway
1. Neues Projekt aus diesem Repo, Region europe-west4 (Dockerfile wird erkannt).
2. Variablen setzen: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_TOKEN, DEFAULT_OUTPUT_BUCKET.
3. Deploy. Öffentliche URL = RENDER_WORKER_URL für n8n.
