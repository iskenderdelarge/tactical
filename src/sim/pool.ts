/// <reference lib="webworker" />
// Inlined worker pool. Vite embeds the worker as a base64 blob inside the
// single-file bundle, so the production build can fan a simulation batch out
// across real cores without shipping a second asset.
import SimWorker from './worker.ts?worker&inline';

export type PoolTask = { type: string } & Record<string, unknown>;

type Incoming = { type: 'progress'; id: number; payload: unknown }
  | { type: 'done'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };

export class SimPool {
  readonly cores: number;
  private workers: Worker[] = [];
  private nextId = 1;
  private pending = new Map<number, (message: Incoming) => void>();

  constructor(lowPower = false) {
    this.cores = lowPower ? 1 : Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
    try {
      for (let i = 0; i < this.cores; i++) {
        const worker = new SimWorker();
        worker.onmessage = (event: MessageEvent<Incoming>) => {
          this.pending.get(event.data.id)?.(event.data);
        };
        this.workers.push(worker);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  run<T, P = unknown>(workerIndex: number, task: PoolTask, onProgress: (payload: P) => void = () => {}): Promise<T | null> {
    const id = this.nextId++;
    const worker = this.workers[workerIndex % this.workers.length];
    return new Promise<T | null>((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.type === 'progress') (onProgress as (payload: unknown) => void)(message.payload);
        else if (message.type === 'error') {
          this.pending.delete(id);
          reject(new Error(message.message));
        } else {
          this.pending.delete(id);
          resolve(message.result as T | null);
        }
      });
      worker.onerror = (event) => {
        this.pending.delete(id);
        reject(new Error(event.message || 'Simulation worker failed'));
      };
      worker.postMessage({ ...task, id });
    });
  }

  cancelAll(): void {
    this.workers.forEach((worker) => worker.postMessage({ type: 'cancel' }));
  }

  dispose(): void {
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.pending.clear();
  }
}

export function createPool(lowPower = false): SimPool | null {
  try {
    return new SimPool(lowPower);
  } catch {
    // Sandboxed contexts can block worker construction; the app falls back to
    // the main thread rather than breaking the Run button.
    return null;
  }
}
