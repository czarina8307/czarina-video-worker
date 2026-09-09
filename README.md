# Czarina Video-Worker

Render-Worker für die Video-Lokalisierung: ersetzt die deutsche Tonspur einer
Bildschirmaufnahme durch eine übersetzte Stimme und liefert Video + `.srt` je
Sprache. Läuft als Docker-Container auf einem eigenen Linux-Server (Hetzner
Cloud), spricht Supabase (Storage + DB). Kein Lip-Sync.

```
n8n  ──POST /render──▶  Caddy (TLS)  ──▶  Worker (Node + ffmpeg)
                                              │  lädt Video + TTS-Clips
                                              │  baut Tonspur exakt in Videolänge
                                              │  muxt, schreibt .srt
                                              ▼
                              Supabase Storage (video-localization) + Tabelle localization_outputs
```

## Endpunkte

| Methode | Pfad      | Auth                              | Antwort |
|---------|-----------|-----------------------------------|---------|
| GET     | `/health` | keine                             | `{ ok, running, pending, concurrency }` |
| POST    | `/render` | `Authorization: Bearer <WORKER_TOKEN>` | `202` angenommen · `400` Body ungültig · `401` Token falsch · `409` Job/Lang läuft bereits |
| POST    | `/extract-audio` | `Authorization: Bearer <WORKER_TOKEN>` | synchron `200 { audio_bucket, audio_path, duration_sec, bytes }` – zieht eine kleine Mono-MP3 (16 kHz, 48 kbit/s) aus dem Video für die Whisper-Transkription (25-MB-Limit) |

Der Request wird sofort mit `202` bestätigt; der Render läuft im Hintergrund
(Warteschlange, standardmässig 1 gleichzeitig). Fortschritt und Ergebnis landen
in `localization_outputs` (`status`: `rendering` → `done` | `error`, dazu
`video_path`, `srt_path`, `duration_sec`, `error`). Optional ruft der Worker
nach Abschluss `callback_url` per POST auf (z.B. n8n-Webhook).

Request-Body:

```json
{
  "job_id": "d4a1…-uuid",
  "lang": "en",
  "source_bucket": "video-localization",
  "source_path": "jobs/d4a1…/source.mp4",
  "output_bucket": "video-localization",
  "output_prefix": "jobs/d4a1…/en",
  "callback_url": "https://n8n.example.com/webhook/render-done",
  "segments": [
    { "start": 0.0,  "end": 3.2, "text": "Welcome to Paintlyy.", "audio_url": "https://…/seg0.mp3" },
    { "start": 3.6,  "end": 7.9, "text": "Let's create an offer.", "audio_url": "https://…/seg1.mp3" }
  ]
}
```

`audio_url` darf wav/mp3/ogg sein (ffmpeg erkennt das Format). Es entstehen
`<output_prefix>.mp4` und `<output_prefix>.srt`. Clips werden auf `start`
platziert; ist ein Clip länger als das Fenster bis zum nächsten Segment, wird er
bis max. 1.35× beschleunigt (atempo), der Rest überlappt und wird gemischt.
Lücken werden mit Stille gefüllt, die Tonspur wird exakt auf die Videolänge gekappt.

`/extract-audio`-Body: `{ "source_bucket", "source_path", "output_bucket"?, "output_path" }`
(z.B. `output_path: "jobs/<job_id>/audio.mp3"`).

## Lokal entwickeln

```bash
cp .env.example .env          # Werte eintragen
npm install
npm run dev                   # http://localhost:8080
npm test                      # ffmpeg-Selbsttest ohne Supabase
npm run typecheck
```

## Server aufsetzen (Hetzner Cloud, einmalig)

1. **Server erstellen**: Hetzner Cloud → Ubuntu 24.04, Standort Nürnberg oder
   Falkenstein, Typ **CX22 / CPX21** (2 vCPU, 4 GB) reicht für den Start;
   eigenen SSH-Key hinterlegen. In der Hetzner-Firewall nur 22, 80, 443 öffnen.
2. **DNS**: A-Record z.B. `worker.czarinajewellery.com` → Server-IPv4
   (optional AAAA → IPv6).
3. **Bootstrap** (als root auf dem Server):
   ```bash
   apt-get update && apt-get install -y git
   git clone https://github.com/<dein-account>/czarina-video-worker.git /opt/czarina-video-worker
   bash /opt/czarina-video-worker/deploy/bootstrap.sh
   ```
   Installiert Docker, UFW, fail2ban, automatische Sicherheitsupdates und legt
   den Benutzer `deploy` an (mit deinem SSH-Key).
4. **Konfigurieren** (als `deploy`):
   ```bash
   cd /opt/czarina-video-worker/deploy
   cp .env.example .env && nano .env     # WORKER_DOMAIN, Supabase-Keys, WORKER_TOKEN
   docker compose up -d --build
   curl https://worker.czarinajewellery.com/health
   ```
   Caddy holt das Let's-Encrypt-Zertifikat automatisch und erneuert es.

Die Worker-URL ist dann `RENDER_WORKER_URL` für n8n, der `WORKER_TOKEN` kommt
als Bearer-Token in den HTTP-Request-Node.

## Deploy bei jedem Push

`.github/workflows/deploy.yml` prüft Typen, Selbsttest und Docker-Build und
rollt danach per SSH aus (`deploy/deploy.sh`: `git pull` → `docker compose
build` → `up -d` → Health-Check). Dafür drei Repository-Secrets anlegen:

| Secret           | Wert |
|------------------|------|
| `DEPLOY_HOST`    | Server-IP oder Hostname |
| `DEPLOY_USER`    | `deploy` |
| `DEPLOY_SSH_KEY` | privater Key eines eigenen Deploy-Keypaars (`ssh-keygen -t ed25519 -f deploy_key`); den Public-Key in `/home/deploy/.ssh/authorized_keys` auf dem Server eintragen |

Ohne GitHub Actions geht es genauso von Hand:
`ssh deploy@<server> 'bash /opt/czarina-video-worker/deploy/deploy.sh'`.

## Betrieb

```bash
cd /opt/czarina-video-worker/deploy
docker compose logs -f worker        # JSON-Logs (ein Eintrag pro Zeile)
docker compose ps                    # Health-Status
docker compose restart worker
```

- Ein laufender Render wird bei Deploy/Restart bis zu 15 Min. fertig gerechnet
  (`stop_grace_period`), neue Jobs werden währenddessen mit `409` abgelehnt.
- `RENDER_CONCURRENCY` erst erhöhen, wenn der Server mehr als 2 vCPU hat.
- Speicher: Arbeitsdateien liegen in `/tmp` im Container (eigenes Volume) und
  werden nach jedem Job gelöscht. Bei sehr langen Videos Server-Disk prüfen
  (`df -h`).
- Uptime-Überwachung: `/health` in einen beliebigen Monitor eintragen
  (z.B. Uptime Kuma, selbst gehostet, oder Hetzner-externe Checks).

## Supabase-Voraussetzungen

- Bucket `video-localization` (privat) mit Quellvideo; Ergebnisse landen im
  gleichen Bucket unter `output_prefix`.
- Tabelle `localization_outputs` mit `unique (job_id, lang)` und Spalten
  `status, video_path, srt_path, duration_sec, error, updated_at`.
- Der Worker nutzt den Service-Role-Key (umgeht RLS) – er läuft ausschliesslich
  serverseitig und ist nur mit `WORKER_TOKEN` erreichbar.
