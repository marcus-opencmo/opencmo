import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { chromiumArgs } from '../src/render.ts';
const server = createServer((_q, r) => r.end('<p>ok</p>')).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: chromiumArgs(false) });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
console.log('loopback:', await page.textContent('p'));
const out = await page.evaluate(`(async () => {
  const tryFetch = (u) => fetch(u, { mode: 'no-cors' }).then(() => 'REACHED').catch((e) => 'blocked ' + e.message);
  const tryWs = (u) => new Promise((res) => { const w = new WebSocket(u); w.onopen = () => res('REACHED'); w.onerror = () => res('blocked'); setTimeout(() => res('timeout'), 8000); });
  return { https: await tryFetch('https://example.com/'), ip: await tryFetch('http://1.1.1.1/'), ws: await tryWs('wss://echo.websocket.org/') };
})()`);
console.log(out);
await browser.close(); server.close();
