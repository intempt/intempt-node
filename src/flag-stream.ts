import type { StreamHandle, StreamHandlers } from './transport';

export type { StreamHandle, StreamHandlers };

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface FlagStreamDeps {
  open(handlers: StreamHandlers): StreamHandle;
  /** `[]` means "drop every entry": a malformed event cannot be trusted to name its keys. */
  onChange(keys: string[]): void;
  onState(connected: boolean): void;
}

/**
 * The one SSE connection to `/flags/stream` (F15, contract C2): reconnects with a backoff of 1 s
 * doubling to 60 s, reset by a successful open. Timers are unref'd so an idle stream never keeps
 * the process alive; `close()` is final.
 */
export class FlagStream {
  readonly #deps: FlagStreamDeps;
  #handle: StreamHandle | undefined;
  #timer: NodeJS.Timeout | undefined;
  #delay = BACKOFF_START_MS;
  #connected = false;
  #closed = false;

  constructor(deps: FlagStreamDeps) {
    this.#deps = deps;
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    if (this.#closed || this.#handle !== undefined || this.#timer !== undefined) return;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#handle?.close();
    this.#handle = undefined;
    this.#setConnected(false);
  }

  #connect(): void {
    const handle = this.#deps.open({
      onOpen: () => {
        if (this.#handle !== handle) return;
        this.#delay = BACKOFF_START_MS;
        this.#setConnected(true);
      },
      onMessage: (event, data) => {
        if (this.#handle !== handle || event !== 'flags_changed') return;
        this.#deps.onChange(keysOf(data));
      },
      onClose: () => {
        if (this.#handle !== handle) return;
        this.#handle = undefined;
        this.#setConnected(false);
        this.#schedule();
      },
    });
    this.#handle = handle;
  }

  #schedule(): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, this.#delay);
    this.#timer.unref();
    this.#delay = Math.min(this.#delay * 2, BACKOFF_MAX_MS);
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    this.#deps.onState(connected);
  }
}

function keysOf(data: string): string[] {
  try {
    const keys = (JSON.parse(data) as { keys?: unknown }).keys;
    if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) return keys;
  } catch {
    // falls through: an unreadable event drops everything
  }
  return [];
}
