import net from 'net';
import fs from 'fs';
import { 
  JsonRpcRequestSchema, 
  JsonRpcResponse, 
  JsonRpcNotification,
  SubscribeParamsSchema,
  LogEvent,
  CoreStatus
} from './schema';

export const DEFAULT_PIPE_NAME = process.platform === 'win32' 
  ? '\\\\.\\pipe\\antigravity_proxy_ipc' 
  : '/tmp/antigravity_proxy_ipc.sock';

export type RpcHandler = (params: any) => Promise<any> | any;

export class NamedPipeIpcServer {
  private server: net.Server | null = null;
  private pipePath: string;
  private handlers: Map<string, RpcHandler> = new Map();
  private subscribers: Map<net.Socket, Set<string>> = new Map();
  private isListening: boolean = false;

  constructor(pipePath: string = DEFAULT_PIPE_NAME) {
    this.pipePath = pipePath;
  }

  public registerMethod(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up old socket file on Unix if it exists
      if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
        try {
          fs.unlinkSync(this.pipePath);
        } catch (e) {
        }
      }

      this.server = net.createServer((socket) => {
        this.handleClientConnection(socket);
      });

      this.server.on('error', (err: any) => {
        console.error(`[IPC Server] Named Pipe Error on ${this.pipePath}:`, err.message);
        if (!this.isListening) {
          reject(err);
        }
      });

      this.server.listen(this.pipePath, () => {
        this.isListening = true;
        console.log(`[IPC Server] Windows Named Pipe IPC listening at: ${this.pipePath}`);
        resolve();
      });
    });
  }

  private handleClientConnection(socket: net.Socket): void {
    const subscriptions = new Set<string>();
    this.subscribers.set(socket, subscriptions);

    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      // Keep last incomplete segment in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const raw = JSON.parse(trimmed);
          const parsed = JsonRpcRequestSchema.safeParse(raw);

          if (!parsed.success) {
            const errResp: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: raw?.id ?? null,
              error: {
                code: -32600,
                message: 'Invalid Request: ' + parsed.error.issues.map((i: any) => i.message).join(', ')
              }
            };
            this.send(socket, errResp);
            continue;
          }

          const req = parsed.data;
          const response = await this.handleRpcRequest(socket, req);
          if (req.id !== undefined && response !== null) {
            this.send(socket, response);
          }
        } catch (e: any) {
          const errResp: JsonRpcResponse = {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error: ' + (e.message || String(e))
            }
          };
          this.send(socket, errResp);
        }
      }
    });

    socket.on('close', () => {
      this.subscribers.delete(socket);
    });

    socket.on('error', () => {
      this.subscribers.delete(socket);
    });
  }

  private async handleRpcRequest(socket: net.Socket, req: { jsonrpc: '2.0'; id?: string | number; method: string; params?: any }): Promise<JsonRpcResponse | null> {
    const { id, method, params } = req;

    // Built-in Subscription handlers
    if (method === 'events.subscribe') {
      const parsed = SubscribeParamsSchema.safeParse(params || {});
      const topics = parsed.success ? parsed.data.topics : ['all'];
      const currentSubs = this.subscribers.get(socket) || new Set<string>();
      for (const t of topics) {
        currentSubs.add(t);
      }
      this.subscribers.set(socket, currentSubs);

      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: { subscribed: Array.from(currentSubs) }
      };
    }

    if (method === 'events.unsubscribe') {
      const parsed = SubscribeParamsSchema.safeParse(params || {});
      const topics = parsed.success ? parsed.data.topics : [];
      const currentSubs = this.subscribers.get(socket);
      if (currentSubs) {
        for (const t of topics) {
          currentSubs.delete(t);
        }
      }
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: { subscribed: Array.from(currentSubs || []) }
      };
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      };
    }

    try {
      const result = await handler(params);
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: result !== undefined ? result : null
      };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32000,
          message: err.message || 'Server internal error',
          data: err.stack
        }
      };
    }
  }

  public broadcast(topic: string, data: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: `event.${topic}`,
      params: data
    };

    const payload = JSON.stringify(notification) + '\n';

    for (const [socket, topics] of this.subscribers.entries()) {
      if (topics.has(topic) || topics.has('all')) {
        try {
          if (!socket.destroyed) {
            socket.write(payload);
          }
        } catch (e) {
        }
      }
    }
  }

  private send(socket: net.Socket, msg: JsonRpcResponse | JsonRpcNotification): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n');
    }
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isListening = false;
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export const ipcServer = new NamedPipeIpcServer();
