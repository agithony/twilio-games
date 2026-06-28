import { HttpServer } from './http-server';

const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const authToken = process.env.TWILIO_AUTH_TOKEN;
// FAIL CLOSED: validate Twilio webhook signatures by DEFAULT whenever an auth token is set,
// regardless of NODE_ENV (a deploy that forgets NODE_ENV=production must NOT silently drop auth).
// Local dev without a token has nothing to validate against; opt out explicitly only if needed.
const validateSignatures = process.env.TWILIO_VALIDATE_SIGNATURES
  ? process.env.TWILIO_VALIDATE_SIGNATURES !== 'false'
  : Boolean(authToken);

if (validateSignatures && !authToken) {
  console.warn('[security] signature validation is ON but TWILIO_AUTH_TOKEN is unset — webhooks will 500 until it is configured.');
}

const srv = new HttpServer({ port, publicBaseUrl, authToken, validateSignatures });
srv.start().then((p) => {
  console.log(`Voice Racer listening on http://localhost:${p}`);
  console.log(`  game WS: ws://localhost:${p}/game   voice WS: ws://localhost:${p}/voice`);
  console.log(`  webhooks: POST ${publicBaseUrl}/voice/incoming , /voice/join`);
  console.log(`  twilio signature validation: ${validateSignatures ? 'ON' : 'OFF'}`);
});
const shutdown = () => srv.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
