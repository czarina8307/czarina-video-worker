import { log } from "./log.js";

type Task = { key: string; run: () => Promise<void> };

/**
 * Kleine In-Memory-Warteschlange mit fester Parallelität.
 * ffmpeg lastet einen kleinen VPS voll aus – mehrere Renders gleichzeitig würden sich nur gegenseitig ausbremsen.
 */
export class RenderQueue {
  private pending: Task[] = [];
  private running = new Set<string>();
  private draining = false;

  constructor(private readonly concurrency: number) {}

  get stats() {
    return { running: this.running.size, pending: this.pending.length, concurrency: this.concurrency };
  }

  /** true = angenommen; false = derselbe Job/Lang läuft oder wartet bereits. */
  enqueue(key: string, run: () => Promise<void>): boolean {
    if (this.draining) return false;
    if (this.running.has(key) || this.pending.some((t) => t.key === key)) return false;
    this.pending.push({ key, run });
    this.pump();
    return true;
  }

  /** Nimmt keine neuen Jobs mehr an und wartet, bis laufende Renders fertig sind (für SIGTERM). */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    this.pending = [];
    const start = Date.now();
    while (this.running.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.running.add(task.key);
      task
        .run()
        .catch((err) => log.error("Job unerwartet abgebrochen", { key: task.key, error: String(err) }))
        .finally(() => {
          this.running.delete(task.key);
          this.pump();
        });
    }
  }
}
