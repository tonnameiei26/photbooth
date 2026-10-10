const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const http = require('http');
const https = require('https');
const express = require('express');
const printer = require('./services/printer');
const storage = require('./services/storage');
const db = require('./db/database');

const PORT = Number(process.env.PORT) || 3443;
const HTTP_DEV_PORT = Number(process.env.HTTP_DEV_PORT) || 3000;
const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, 'certs');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');

const sessions = new Map();
const MAX_PRINT_COPIES = 10; // keep in sync with MAX_PRINT_COPIES in app.js
// Sessions live in memory (photo included) only while a guest is using the booth.
// One left untouched this long is forgotten; its row in SQLite stays as history.
const SESSION_MAX_AGE_MS = 10 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
// Experimental: a short behind-the-scenes video of the countdown, offered as a
// third QR code. Off unless VIDEO_CLIP=true is set in .env.
const VIDEO_CLIP_ENABLED = process.env.VIDEO_CLIP === 'true';
const CLIP_MAX_SIZE = '20mb';
const allowedStates = new Set(['IDLE', 'SELECT_SHOTS', 'CAMERA', 'PREVIEW', 'SELECT_PRINT_COPIES', 'PRINTING', 'DONE', 'TIMEOUT']);

function createSession() {
  const now = new Date().toISOString();
  const session = { id: crypto.randomUUID(), state: 'IDLE', photoCount: null, frame: null, photo: null, printCopies: 1, print: 'NOT_STARTED', uploadStatus: 'NOT_STARTED', photoUrl: null, qrCode: null, photoUrlBw: null, qrCodeBw: null, clipStatus: 'NOT_STARTED', clipUrl: null, qrCodeClip: null, createdAt: now, updatedAt: now };
  sessions.set(session.id, session);
  db.saveSession(session);
  return session;
}

function updateSession(session, changes) {
  Object.assign(session, changes, { updatedAt: new Date().toISOString() });
  db.saveSession(session);
  return session;
}

function forgetStaleSessions() {
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  for (const session of sessions.values()) {
    // A long multi-copy job is still being fed to the printer; leave it alone.
    if (session.print === 'PROCESSING' || session.uploadStatus === 'PROCESSING' || session.clipStatus === 'PROCESSING') continue;
    if (Date.parse(session.updatedAt) < cutoff) sessions.delete(session.id);
  }
}
setInterval(forgetStaleSessions, SESSION_SWEEP_INTERVAL_MS).unref();

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

api.get('/config', (request, response) => {
  response.json({ videoClip: VIDEO_CLIP_ENABLED });
});

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
  if (payload.photoCount !== undefined) {
    if (!Number.isInteger(payload.photoCount) || payload.photoCount < 1 || payload.photoCount > 4) return response.status(400).json({ error: 'photoCount must be an integer from 1 to 4' });
    changes.photoCount = payload.photoCount;
  }
  if (payload.frame !== undefined) changes.frame = String(payload.frame);
  if (payload.printCopies !== undefined) {
    if (!Number.isInteger(payload.printCopies) || payload.printCopies < 1 || payload.printCopies > MAX_PRINT_COPIES) return response.status(400).json({ error: `printCopies must be an integer from 1 to ${MAX_PRINT_COPIES}` });
    changes.printCopies = payload.printCopies;
  }
  response.json({ session: updateSession(request.session, changes) });
});

api.post('/sessions/:id/photo', requireSession, (request, response) => {
  const payload = request.body;
  if (typeof payload.photo !== 'string' || !payload.photo.startsWith('data:image/')) return response.status(400).json({ error: 'Photo must be a data URL' });
  response.json({ session: updateSession(request.session, { state: 'PREVIEW', photo: payload.photo }) });
});

api.post('/sessions/:id/print', requireSession, (request, response) => {
  const session = request.session;
  const payload = request.body || {};
  let printCopies = session.printCopies || 1;
  if (payload.printCopies !== undefined) {
    if (!Number.isInteger(payload.printCopies) || payload.printCopies < 1 || payload.printCopies > MAX_PRINT_COPIES) return response.status(400).json({ error: `printCopies must be an integer from 1 to ${MAX_PRINT_COPIES}` });
    printCopies = payload.printCopies;
  }
  if (session.print === 'PROCESSING') return response.status(409).json({ error: 'Print already in progress for this session' });
  if (!session.photo) return response.status(409).json({ error: 'A photo must be uploaded before printing' });
  // The print and upload jobs below each keep their own hold on the photo until
  // they finish, so the session can let go of it now. Otherwise every guest's
  // photo would pile up in the Pi's memory, and the iPad would be sent the whole
  // photo again each time it asks whether the QR codes are ready.
  const photo = session.photo;
  // An unplugged or switched-off printer is recorded as a failed print instead of
  // refusing the whole request, so the guest still gets QR codes for their photo.
  const printerReady = printer.isReady();
  const printFailed = (error) => {
    console.error(`Print failed for session ${session.id}: ${error.message}`);
    updateSession(session, { state: 'DONE', print: 'FAILED', printError: error.message });
  };
  updateSession(session, { state: 'PRINTING', print: 'PROCESSING', printCopies, uploadStatus: 'PROCESSING', photo: null });
  if (printerReady) {
    printer.printPhoto(photo, printCopies, session.frame)
      .then(() => updateSession(session, { state: 'DONE', print: 'SUCCESS', printedAt: new Date().toISOString() }))
      .catch(printFailed);
  } else {
    printFailed(new Error('Printer is not connected'));
  }
  storage.uploadAndGenerateQr(photo, session.id)
    .then(({ photoUrl, qrCode, photoUrlBw, qrCodeBw }) => updateSession(session, { uploadStatus: 'DONE', photoUrl, qrCode, photoUrlBw, qrCodeBw }))
    .catch((error) => {
      console.error(`Upload failed for session ${session.id}: ${error.message}`);
      updateSession(session, { uploadStatus: 'FAILED', uploadError: error.message });
    });
  response.status(202).json({ session });
});

// The iPad sends the clip as the raw video file (not JSON) once the guest has
// confirmed their photo. It is only held in memory while it uploads.
api.post('/sessions/:id/clip', requireSession, express.raw({ type: 'video/*', limit: CLIP_MAX_SIZE }), (request, response) => {
  const session = request.session;
  if (!VIDEO_CLIP_ENABLED) return response.status(404).json({ error: 'Video clips are switched off' });
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) return response.status(400).json({ error: 'Clip must be sent as a video file' });
  if (session.clipStatus !== 'NOT_STARTED') return response.status(409).json({ error: 'A clip was already sent for this session' });
  updateSession(session, { clipStatus: 'PROCESSING' });
  storage.uploadClipAndGenerateQr(request.body, session.id)
    .then(({ clipUrl, qrCodeClip }) => updateSession(session, { clipStatus: 'DONE', clipUrl, qrCodeClip }))
    .catch((error) => {
      console.error(`Clip upload failed for session ${session.id}: ${error.message}`);
      updateSession(session, { clipStatus: 'FAILED', clipError: error.message });
    });
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
