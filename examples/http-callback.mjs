// A callback endpoint with nothing but Node's http module.
//
//   PAYGATE_CALLBACK_SECRET=... PAYGATE_SITE_URL=https://shop.example node examples/http-callback.mjs

import { createServer } from 'node:http';
import { CallbackData, CallbackToken, PayGate } from 'paygate-to';

if (!process.env.PAYGATE_SITE_URL) {
  throw new Error('Set PAYGATE_SITE_URL to the public URL of this server.');
}

const paygate = new PayGate();
const tokens = new CallbackToken(process.env.PAYGATE_CALLBACK_SECRET);
const CALLBACK_URL = `${process.env.PAYGATE_SITE_URL.replace(/\/+$/, '')}/paygate/callback`;
const credited = new Set(); // use your database

createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/paygate/callback')) {
      res.writeHead(404).end();
      return;
    }
    const result = await paygate.callbacks.verifyRequest(CALLBACK_URL, req);
    const data = CallbackData.fromRequest(req);
    if (!result.valid || !tokens.verify(data.get('order'), data.get('token'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
      return;
    }
    if (!data.pending && !credited.has(data.txidIn)) {
      credited.add(data.txidIn);
      // Before shipping, compare data.coin and data.valueCoin with the order (see examples/express).
      console.log(`Order ${data.get('order')}: received ${data.valueCoin} ${data.coin}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('error'); // not "ok": PayGate.to will call again
  }
}).listen(Number(process.env.PORT ?? 3001));
