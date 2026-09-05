const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');
const printer = require('./services/printer');

const PORT = Number(process.env.PORT) || 3443;
const HTTP_DEV_PORT = Number(process.env.HTTP_DEV_PORT) || 3000;
const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, 'certs');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');

const sessions = new Map();
const allowedStates = new Set(['IDLE', 'SELECT_QUANTITY', 'SELECT_FRAME', 'WAIT_PAYMENT', 'CAMERA', 'PREVIEW', 'PRINTING', 'DONE', 'TIMEOUT']);

function createSession() {
  const now = new Date().toISOString();
  const session = { id: crypto.randomUUID(), state: 'IDLE', quantity: null, price: null, frame: null, photo: null, payment: 'NOT_REQUIRED', print: 'NOT_STARTED', createdAt: now, updatedAt: now };
  sessions.set(session.id, session);
  return session;
}

function updateSession(session, changes) {
  Object.assign(session, changes, { updatedAt: new Date().toISOString() });
  return session;
}

function requireSession(request, response, next) {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: 'Session not found' });
  request.session = session;
  next();
}

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error(`Missing HTTPS certificate. Expected files at:\n  ${CERT_PATH}\n  ${KEY_PATH}\nRun mkcert to generate them first (see README).`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '15mb' }));

const api = express.Router();

api.post('/sessions', (request, response) => {
  response.status(201).json({ session: createSession() });
});

api.get('/sessions/:id', requireSession, (request, response) => {
  response.json({ session: request.session });
});

api.patch('/sessions/:id', requireSession, (request, response) => {
  const payload = request.body;
  const changes = {};
  if (payload.state !== undefined) {
    if (!allowedStates.has(payload.state)) return response.status(400).json({ error: 'Invalid session state' });
    changes.state = payload.state;
  }
  if (payload.quantity !== undefined) {
    if (!Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 4) return response.status(400).json({ error: 'Quantity must be an integer from 1 to 4' });
    changes.quantity = payload.quantity;
    changes.price = payload.quantity * 50;
  }
  if (payload.frame !== undefined) changes.frame = String(payload.frame);
  response.json({ session: updateSession(request.session, changes) });
});

api.post('/sessions/:id/payment/mock', requireSession, (request, response) => {
  const session = request.session;
  if (!session.quantity || !session.price) return response.status(409).json({ error: 'Quantity must be selected before payment' });
  response.json({ session: updateSession(session, { state: 'CAMERA', payment: 'SUCCESS', paidAt: new Date().toISOString() }) });
});

api.post('/sessions/:id/photo', requireSession, (request, response) => {
  const payload = request.body;
  if (typeof payload.photo !== 'string' || !payload.photo.startsWith('data:image/')) return response.status(400).json({ error: 'Photo must be a data URL' });
  response.json({ session: updateSession(request.session, { state: 'PREVIEW', photo: payload.photo }) });
});

api.post('/sessions/:id/print', requireSession, (request, response) => {
  const session = request.session;
  if (!session.photo) return response.status(409).json({ error: 'A photo must be uploaded before printing' });
  if (!printer.isReady()) return response.status(503).json({ error: 'Printer is not connected' });
  updateSession(session, { state: 'PRINTING', print: 'PROCESSING' });
  printer.printPhoto(session.photo, session.quantity || 1)
    .then(() => updateSession(session, { state: 'DONE', print: 'SUCCESS', printedAt: new Date().toISOString() }))
    .catch((error) => updateSession(session, { state: 'DONE', print: 'FAILED', printError: error.message }));
  response.status(202).json({ session });
});

api.use((request, response) => response.status(404).json({ error: 'API route not found' }));

app.use('/api', api);
app.use(express.static(ROOT, { extensions: ['html'] }));

app.use((request, response) => response.status(404).json({ error: 'File not found' }));

app.use((error, request, response, next) => {
  const statusCode = error.type === 'entity.too.large' ? 413 : 400;
  response.status(statusCode).json({ error: error.message });
});

https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, app).listen(PORT, () => {
  console.log(`Receipt Photo Booth server running at https://localhost:${PORT}`);
});

// Plain HTTP, bound to localhost only. Browsers treat http://localhost as a secure
// context (getUserMedia works) without any certificate, but only for the literal
// hostname "localhost" -- not for the Pi's LAN IP. Useful for dev machines reaching
// the Pi through an SSH/VS Code port-forward. Real devices on the network (iPad) must
// still use the HTTPS port above with the mkcert certificate.
http.createServer(app).listen(HTTP_DEV_PORT, '127.0.0.1', () => {
  console.log(`Dev-only HTTP server (localhost tunnel access) running at http://localhost:${HTTP_DEV_PORT}`);
});
