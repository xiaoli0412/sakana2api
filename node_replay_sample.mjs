import fs from 'fs';
import { findPageTarget, CdpSession } from './lib/cdp.js';

const sample = JSON.parse(fs.readFileSync('success_sample.json', 'utf8'));
const cookieHeader = JSON.parse(fs.readFileSync('session.json', 'utf8')).cookieHeader;

// 1) Node-side bootstrap to get a fresh conversation (same as browser)
const bootResp = await fetch('https://chat.sakana.ai/api/conversation', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' },
  body: JSON.stringify({ inputs: '字节重放', enableThinking: false, toneMode: 'default', webSearchEnabled: false, model: 'sakana-namazu' })
});
console.log('node bootstrap status:', bootResp.status);
const boot = await bootResp.json();
console.log('conv:', boot.conversationId);

// 2) replay the EXACT captured bytes but with new conversationId + systemMessageId
const b64 = sample.bodyB64;
const raw = Buffer.from(b64, 'base64').toString('utf8');
// substitute ids inside the data JSON
const dataField = raw.match(/name="data"\r\n\r\n(.*?)\r\n------/s)[1];
const d = JSON.parse(dataField);
d.id = boot.systemMessageId;
d.inputs = '字节重放';
const newRaw = raw.replace(dataField, JSON.stringify(d));

const resp = await fetch('https://chat.sakana.ai/api/conversation/' + boot.conversationId, {
  method: 'POST',
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'content-type': 'multipart/form-data; boundary=' + newRaw.match(/^--(.*?)\r\n/)[1],
    origin: 'https://chat.sakana.ai',
    referer: 'https://chat.sakana.ai/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie: cookieHeader,
    ...(newRaw.includes('datadog') ? {} : {}),
  },
  body: newRaw,
  // @ts-ignore undici allows raw string body with content-type override
  duplex: 'half',
});
console.log('REPLAY status:', resp.status);
console.log('head:', (await resp.text()).slice(0, 250));
