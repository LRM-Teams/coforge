import type { Socket } from "bun";

/** Private one-connection relay; bounded framing and partial-write handling. */
export class ProcessChannel {
  #input = "";
  #decoder = new TextDecoder();
  #pending = Buffer.alloc(0);
  #waiters: Array<() => void> = [];
  #socket: Socket | undefined;
  #closed = false;
  constructor(private readonly receive: (record: Record<string, unknown>) => void) {}
  attach(socket: Socket) {
    this.#socket = socket;
    this.drain();
  }
  read(data: Uint8Array) {
    this.#input += this.#decoder.decode(data, { stream: true });
    if (this.#input.length > 8 * 1024 * 1024) throw new Error("Agent relay input exceeded limit");
    let end: number;
    while ((end = this.#input.indexOf("\n")) >= 0) {
      const value: unknown = JSON.parse(this.#input.slice(0, end));
      this.#input = this.#input.slice(end + 1);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid Agent relay message");
      this.receive(value as Record<string, unknown>);
    }
  }
  send(record: Record<string, unknown>) {
    if (this.#closed) throw new Error("Agent relay is closed");
    const next = Buffer.from(JSON.stringify(record) + "\n");
    if (this.#pending.length + next.length > 8 * 1024 * 1024)
      throw new Error("Agent relay output exceeded limit");
    this.#pending = Buffer.concat([this.#pending, next]);
    this.drain();
  }
  drain() {
    if (!this.#socket || !this.#pending.length) return;
    const written = this.#socket.write(this.#pending);
    if (written < 0) throw new Error("Agent relay write failed");
    this.#pending = this.#pending.subarray(written);
    if (!this.#pending.length) this.#release();
  }
  async flush() {
    if (this.#pending.length && !this.#closed)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.#closed) throw new Error("Agent relay is closed");
  }
  close() {
    this.#closed = true;
    this.#socket?.terminate();
    this.#release();
  }
  #release() {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
