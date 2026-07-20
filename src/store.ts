import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

interface EventState {
  processedEventIds: string[];
}

export class DurableEventStore {
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(dataDir: string) {
    this.statePath = join(dataDir, "processed-events.json");
    this.lockPath = join(dataDir, "processed-events.lock");
  }

  async claim(eventId: string): Promise<boolean> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const release = await this.acquireLock();
    try {
      const state = await this.readState();
      if (state.processedEventIds.includes(eventId)) return false;
      state.processedEventIds.push(eventId);
      if (state.processedEventIds.length > 10_000) state.processedEventIds.splice(0, state.processedEventIds.length - 10_000);
      const tempPath = `${this.statePath}.${process.pid}.tmp`;
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      );
      await rename(tempPath, this.statePath);
      return true;
    } finally {
      await release();
    }
  }

  private async readState(): Promise<EventState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<EventState>;
      return { processedEventIds: Array.isArray(parsed.processedEventIds) ? parsed.processedEventIds.filter((x): x is string => typeof x === "string") : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { processedEventIds: [] };
      throw error;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        return async () => {
          await handle.close();
          await import("node:fs/promises").then(({ unlink }) => unlink(this.lockPath).catch(() => undefined));
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() - started > 2_000) throw new Error("Timed out acquiring event store lock");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
  }
}
