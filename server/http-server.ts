import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GameServer } from './game-server';
import { ConversationRelayAdapter } from './conversation-relay';
import { twimlGatherRoomCode, twimlConnectRelay } from './twiml';
import { validateTwilioSignature } from './twilio-signature';

export class HttpServer {
  private server: http.Server;
  private game: GameServer;
  private voiceWss: WebSocketServer;
  private readonly port: number;
  private readonly authToken?: string;
  private readonly publicBaseUrl: string;
  private readonly validateSignatures: boolean;

  constructor(opts: {
    port: number;
    authToken?: string;
    publicBaseUrl: string;
    broadcastHz?: number;
    validateSignatures?: boolean;
  }) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.validateSignatures = opts.validateSignatures ?? true;
    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res);
    });
    this.game = new GameServer({ server: this.server, broadcastHz: opts.broadcastHz });
    this.voiceWss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/voice') {
        this.voiceWss.handleUpgrade(req, socket, head, (ws) => this.onVoiceConnection(ws));
      } else if (path === '/game') {
        this.game.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  private onVoiceConnection(ws: WebSocket): void {
    const adapter = new ConversationRelayAdapter({
      findOrCreateRoom: (code) => this.game.getOrCreateRoom(code),
    });
    ws.on('message', (d) => adapter.handleMessage(d.toString()));
    ws.on('close', () => adapter.handleClose());
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && (path === '/voice/incoming' || path === '/voice/join')) {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      const fullUrl = `${this.publicBaseUrl}${path}`;
      if (this.validateSignatures && this.authToken) {
        const sig = req.headers['x-twilio-signature'];
        const ok = validateTwilioSignature({
          authToken: this.authToken,
          signature: Array.isArray(sig) ? sig[0] : sig,
          url: fullUrl,
          params,
        });
        if (!ok) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const xml = path === '/voice/incoming'
        ? twimlGatherRoomCode({ actionUrl: `${this.publicBaseUrl}/voice/join` })
        : twimlConnectRelay({
            wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
            sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
            roomCode: (params['Digits'] ?? '').trim() || '0000',
          });
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(xml);
      return;
    }
    if (req.method === 'POST' && path === '/voice/session-ended') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end('not found');
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.game.stopLoopOnly();
      this.server.close(() => resolve());
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}
