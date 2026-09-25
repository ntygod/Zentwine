/** Narrow used surface of the pinned ws 8.21.3 package; not a replacement for its full API types. */
declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  export class WebSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;
    on(
      event: "message",
      listener: (data: Buffer, isBinary: boolean) => void,
    ): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
  }
  export class WebSocketServer {
    constructor(options: {
      noServer: true;
      maxPayload: number;
      perMessageDeflate: false;
      maxFragments: number;
      maxBufferedChunks: number;
    });
    readonly clients: Set<WebSocket>;
    on(event: "error", listener: (error: Error) => void): this;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void,
    ): void;
    close(callback: () => void): void;
  }
}
