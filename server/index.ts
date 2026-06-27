import { HttpServer } from './http-server';

const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const validateSignatures = process.env.NODE_ENV === 'production';

const srv = new HttpServer({ port, publicBaseUrl, authToken, validateSignatures });
srv.start().then((p) => {
  console.log(`Voice Racer listening on http://localhost:${p}`);
  console.log(`  game WS: ws://localhost:${p}/game   voice WS: ws://localhost:${p}/voice`);
  console.log(`  webhooks: POST ${publicBaseUrl}/voice/incoming , /voice/join`);
});
process.on('SIGINT', () => srv.stop().then(() => process.exit(0)));
