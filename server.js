const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const sessions = new Map();
const allowedStates = new Set(['IDLE', 'SELECT_QUANTITY', 'SELECT_FRAME', 'WAIT_PAYMENT', 'CAMERA', 'PREVIEW', 'PRINTING', 'DONE', 'TIMEOUT']);
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mov': 'video/quicktime' };

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 15 * 1024 * 1024) reject(new Error('Request body is too large'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(new Error('Request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

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

function getSession(request, response, id) {
  const session = sessions.get(id);
  if (!session) sendError(response, 404, 'Session not found');
  return session;
}

async function handleApi(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    return sendJson(response, 201, { session: createSession() });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === 'GET' && sessionMatch) {
    const session = getSession(request, response, sessionMatch[1]);
    return session && sendJson(response, 200, { session });
  }

  if (request.method === 'PATCH' && sessionMatch) {
    const session = getSession(request, response, sessionMatch[1]);
    if (!session) return;
    const payload = await readJson(request);
    const changes = {};
    if (payload.state !== undefined) {
      if (!allowedStates.has(payload.state)) return sendError(response, 400, 'Invalid session state');
      changes.state = payload.state;
    }
    if (payload.quantity !== undefined) {
      if (!Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 4) return sendError(response, 400, 'Quantity must be an integer from 1 to 4');
      changes.quantity = payload.quantity;
      changes.price = payload.quantity * 50;
    }
    if (payload.frame !== undefined) changes.frame = String(payload.frame);
    return sendJson(response, 200, { session: updateSession(session, changes) });
  }

  const paymentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/payment\/mock$/);
  if (request.method === 'POST' && paymentMatch) {
    const session = getSession(request, response, paymentMatch[1]);
    if (!session) return;
    if (!session.quantity || !session.price) return sendError(response, 409, 'Quantity must be selected before payment');
    return sendJson(response, 200, { session: updateSession(session, { state: 'CAMERA', payment: 'SUCCESS', paidAt: new Date().toISOString() }) });
  }

  const photoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/photo$/);
  if (request.method === 'POST' && photoMatch) {
    const session = getSession(request, response, photoMatch[1]);
    if (!session) return;
    const payload = await readJson(request);
    if (typeof payload.photo !== 'string' || !payload.photo.startsWith('data:image/')) return sendError(response, 400, 'Photo must be a data URL');
    return sendJson(response, 200, { session: updateSession(session, { state: 'PREVIEW', photo: payload.photo }) });
  }

  const printMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/print$/);
  if (request.method === 'POST' && printMatch) {
    const session = getSession(request, response, printMatch[1]);
    if (!session) return;
    if (!session.photo) return sendError(response, 409, 'A photo must be uploaded before printing');
    updateSession(session, { state: 'PRINTING', print: 'PROCESSING' });
    setTimeout(() => updateSession(session, { state: 'DONE', print: 'SUCCESS', printedAt: new Date().toISOString() }), 3000);
    return sendJson(response, 202, { session });
  }

  sendError(response, 404, 'API route not found');
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(response, 404, 'File not found');
  const fileStats = fs.statSync(filePath);
  const contentType = mimeTypes[path.extname(filePath)] || 'application/octet-stream';
  const range = request.headers.range;
  if (range && contentType.startsWith('video/')) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const requestedEnd = match[2] ? Number(match[2]) : fileStats.size - 1;
      const end = Math.min(requestedEnd, fileStats.size - 1);
      if (start <= end && start < fileStats.size) {
        response.writeHead(206, { 'Content-Type': contentType, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${fileStats.size}`, 'Accept-Ranges': 'bytes' });
        return fs.createReadStream(filePath, { start, end }).pipe(response);
      }
    }
    response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
    return response.end();
  }
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': fileStats.size, 'Accept-Ranges': contentType.startsWith('video/') ? 'bytes' : 'none' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return response.end();
  }
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (request.method === 'GET') serveStatic(request, response, url.pathname);
    else sendError(response, 405, 'Method not allowed');
  } catch (error) {
    sendError(response, error.message === 'Request body is too large' ? 413 : 400, error.message);
  }
});

server.listen(PORT, () => console.log(`Receipt Photo Booth server running at http://localhost:${PORT}`));
