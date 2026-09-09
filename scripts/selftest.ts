/**
 * Selbsttest ohne Supabase: erzeugt ein 8-s-Testvideo und zwei Ton-Clips mit ffmpeg,
 * baut die Tonspur, muxt sie ein und prüft Länge/Streams.  Aufruf: npm test
 */
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { buildLocalizedAudio, computeTempos, extractAudio, muxAudioOntoVideo, probeDuration, MAX_TEMPO } from "../src/ffmpeg.js";
import { buildSrt } from "../src/srt.js";
import type { Segment } from "../src/types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FEHLER: ${msg}`);
}

const dir = await mkdtemp(join(tmpdir(), "selftest-"));
try {
  const video = join(dir, "source.mp4");
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=220",
    "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", video]);

  // Clip 1: 2 s WAV, Clip 2: 1.5 s MP3 (unterschiedliche Formate/Raten absichtlich)
  const clip1 = join(dir, "c1.audio");
  const clip2 = join(dir, "c2.audio");
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000", "-t", "2", "-f", "wav", clip1]);
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100", "-t", "1.5", "-f", "mp3", clip2]);

  const segments: Segment[] = [
    { start: 1.0, end: 3.0, text: "Hello and welcome.", audio_url: "http://x/1" },
    { start: 5.25, end: 6.75, text: "Second line\nwith break", audio_url: "http://x/2" },
  ];

  const duration = await probeDuration(video);
  assert(Math.abs(duration - 8) < 0.2, `Testvideo-Dauer unerwartet: ${duration}`);

  const wav = join(dir, "localized.wav");
  await buildLocalizedAudio(segments, [clip1, clip2], duration, wav);
  const wavDur = await probeDuration(wav);
  assert(Math.abs(wavDur - duration) < 0.05, `Tonspur (${wavDur}s) weicht von Videolänge (${duration}s) ab`);

  const out = join(dir, "out.mp4");
  await muxAudioOntoVideo(video, wav, duration, out);
  const { stdout } = await execa("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", out]);
  assert(stdout.includes("h264,video"), "Video-Stream fehlt/nicht kopiert");
  assert(stdout.includes("aac,audio"), "AAC-Tonspur fehlt");
  const outDur = await probeDuration(out);
  assert(Math.abs(outDur - duration) < 0.15, `Ausgabe-Dauer ${outDur}s statt ${duration}s`);
  assert((await stat(out)).size > 10_000, "Ausgabedatei verdächtig klein");

  // Einzel-Segment-Pfad (anderer Filtergraph)
  await buildLocalizedAudio([segments[0]], [clip1], duration, join(dir, "single.wav"));

  // Tempo-Anpassung: Clip 2 s in 1.5-s-Fenster -> 1.333; Clip 3 s in 1-s-Fenster -> gekappt auf MAX_TEMPO; passender Clip -> 1
  const tempos = computeTempos(
    [{ start: 0, end: 1, text: "", audio_url: "" }, { start: 1.5, end: 2, text: "", audio_url: "" }, { start: 2.5, end: 3, text: "", audio_url: "" }],
    [2.0, 3.0, 1.0], 10);
  assert(Math.abs(tempos[0] - 1.3333) < 0.001, `tempo[0] = ${tempos[0]}`);
  assert(tempos[1] === MAX_TEMPO, `tempo[1] = ${tempos[1]}`);
  assert(tempos[2] === 1, `tempo[2] = ${tempos[2]}`);

  // Audio-Extraktion fürs Transkribieren
  const extracted = join(dir, "audio.mp3");
  await extractAudio(video, extracted);
  const exDur = await probeDuration(extracted);
  assert(Math.abs(exDur - duration) < 0.2, `Extrahierte Tonspur ${exDur}s statt ${duration}s`);
  assert((await stat(extracted)).size < 100_000, "Extrahierte Tonspur zu gross");

  const srt = buildSrt(segments);
  await writeFile(join(dir, "out.srt"), srt);
  assert(srt.startsWith("1\n00:00:01,000 --> 00:00:03,000\nHello and welcome.\n"), "SRT-Format falsch");
  assert(srt.includes("2\n00:00:05,250 --> 00:00:06,750\nSecond line\nwith break\n"), "SRT-Block 2 falsch");

  console.log("Selbsttest OK", { duration, wavDur, outDur });
} finally {
  await rm(dir, { recursive: true, force: true });
}
