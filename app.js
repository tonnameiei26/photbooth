const CAMERA_ZOOM = 1.6;
// CAMERA_ZOOM is measured against a 4:5 portrait view of the camera (see drawCover).
const CAMERA_PREVIEW_RATIO = 4 / 5;
const CAMERA_BRIGHTNESS = 1;
document.documentElement.style.setProperty('--camera-zoom', CAMERA_ZOOM);
document.documentElement.style.setProperty('--camera-brightness', CAMERA_BRIGHTNESS);

// iOS "Add to Home Screen" apps report a page height that is one status bar
// shorter than the real display, which leaves an empty strip at the bottom.
// When that happens, tell the CSS the true screen height (see .booth-shell).
function fitStandaloneHeight() {
  const isHomeScreenApp = window.navigator.standalone === true;
  const isPortrait = window.matchMedia('(orientation: portrait)').matches;
  const screenHeight = isHomeScreenApp && isPortrait ? window.screen.height : 0;
  if (screenHeight > window.innerHeight) {
    document.documentElement.style.setProperty('--app-height', `${screenHeight}px`);
  } else {
    document.documentElement.style.removeProperty('--app-height');
  }
}
fitStandaloneHeight();
window.addEventListener('resize', fitStandaloneHeight);
window.addEventListener('orientationchange', fitStandaloneHeight);

const state = {
  screen: 'start',
  photoCount: null,
  frame: null,
  capturedPhotos: [],
  composedPhoto: null,
  printCopies: 1,
  cameraStream: null,
  countdownTimer: null,
  countdownRunning: false,
  serverSessionId: null,
  serverSessionPromise: null,
  qrLoading: false
};

const screens = [...document.querySelectorAll('[data-screen]')];
const video = document.querySelector('#webcamVideo');
const cameraStage = document.querySelector('.camera-stage');
const canvas = document.querySelector('#photoCanvas');
const preview = document.querySelector('#photoPreview');
const countdown = document.querySelector('#countdown');
const cameraFlash = document.querySelector('#cameraFlash');
const cameraMessage = document.querySelector('#cameraMessage');
const toast = document.querySelector('#toast');
const startScreen = document.querySelector('[data-screen="start"]');
const printCopiesPreview = document.querySelector('#printCopiesPreview');
const printCopiesValue = document.querySelector('#printCopiesValue');
const printCopiesMinus = document.querySelector('#printCopiesMinus');
const printCopiesPlus = document.querySelector('#printCopiesPlus');
const scanQrBoxColor = document.querySelector('#scanQrBoxColor');
const scanQrBoxBw = document.querySelector('#scanQrBoxBw');
const scanNotice = document.querySelector('#scanNotice');
const scanFootnote = document.querySelector('#scanFootnote');
const cameraBackButton = document.querySelector('#cameraBackButton');
const previewWraps = document.querySelectorAll('.photo-preview-wrap');
let touchStartY = null;
let touchDistance = 0;
let toastTimer = null;
let startTransitionTimer = null;
let printingTimer = null;

// Most copies a guest can pick on the Select Copies screen (server.js enforces the same limit).
const MAX_PRINT_COPIES = 10;

// How long each screen waits with no touch before the booth goes back to the
// start screen, so a guest who walks away does not leave their photo or QR
// codes on show for the next person. Screens not listed never time out: the
// start screen is already home, and the printing screen moves on by itself.
// The QR screen waits longer because guests are busy with their phone there,
// not with the iPad.
const IDLE_TIMEOUT_MS = 20000;
const IDLE_TIMEOUTS = {
  shots: IDLE_TIMEOUT_MS,
  camera: IDLE_TIMEOUT_MS,
  preview: 30000,
  printcopies: IDLE_TIMEOUT_MS,
  scan: 60000
};
let idleTimer = null;

// Longest the QR screen waits for the photo upload before giving up. The server
// retries a failed upload (see services/storage.js), so this has to outlast that.
const QR_WAIT_MS = 70000;
// How long the QR screen keeps checking whether the print job went through.
const PRINT_WAIT_MS = 120000;

// Blank photo-slot rectangles measured directly from each frame PNG's printed
// border lines (pixel coordinates in the frame's own native resolution).
// These are first-pass measurements -- nudge them here if a print run shows
// a photo sitting off-center inside its slot.
const FRAME_LAYOUTS = {
  1: {
    src: 'assets/pic1.png', width: 945, height: 1772,
    slots: [{ x: 108, y: 244, width: 753, height: 735 }]
  },
  2: {
    src: 'assets/pic2.png', width: 889, height: 2000,
    slots: [
      { x: 136, y: 205, width: 638, height: 527 },
      { x: 136, y: 747, width: 638, height: 527 }
    ]
  },
  3: {
    src: 'assets/pic3.png', width: 800, height: 2000,
    slots: [
      { x: 92, y: 205, width: 637, height: 367 },
      { x: 92, y: 583, width: 637, height: 367 },
      { x: 92, y: 960, width: 637, height: 367 }
    ]
  },
  4: {
    src: 'assets/pic4.png', width: 800, height: 2000,
    slots: [
      { x: 51, y: 238, width: 353, height: 510 },
      { x: 417, y: 238, width: 353, height: 510 },
      { x: 51, y: 766, width: 353, height: 510 },
      { x: 417, y: 766, width: 353, height: 510 }
    ]
  }
};

async function apiRequest(endpoint, options = {}, { quiet = false } = {}) {
  try {
    const response = await fetch(endpoint, { headers: { 'Content-Type': 'application/json' }, ...options });
    const responseText = await response.text();
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      throw new Error('Backend response was not valid JSON');
    }
    if (response.status === 404 && endpoint.startsWith('/api/sessions/')) {
      handleLostSession();
      return null;
    }
    if (!response.ok) throw new Error(payload.error || 'Server request failed');
    return payload;
  } catch (error) {
    if (!quiet) notify(`Server unavailable: ${error.message}`);
    return null;
  }
}

// The server keeps in-progress sessions in memory only, so a restart (for
// example after a power cut) forgets the photo the guest just took and it can
// no longer be printed. Tell them and go back to the start screen to begin again.
function handleLostSession() {
  if (state.screen === 'start') return;
  resetSession();
  notify('ขออภัย ระบบเพิ่งเริ่มใหม่ กรุณาเริ่มถ่ายรูปอีกครั้ง', 6000);
}

async function ensureServerSession() {
  if (state.serverSessionId) return state.serverSessionId;
  if (!state.serverSessionPromise) {
    state.serverSessionPromise = apiRequest('/api/sessions', { method: 'POST', body: '{}' });
  }
  const result = await state.serverSessionPromise;
  state.serverSessionId = result?.session?.id || null;
  state.serverSessionPromise = null;
  return state.serverSessionId;
}

async function syncServerSession(changes) {
  const sessionId = await ensureServerSession();
  if (!sessionId) return false;
  return Boolean(await apiRequest(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(changes) }));
}

function showScreen(screenName) {
  const screen = screens.find((item) => item.dataset.screen === screenName);
  if (!screen) return;
  screens.forEach((item) => item.classList.toggle('screen--active', item === screen));
  state.screen = screenName;
  if (screenName !== 'camera') stopCamera();
  restartIdleTimer();
}

// Moments when the booth itself is working and nobody is expected to touch the
// screen: the 3-2-1 countdown, sending the print job, and fetching the QR codes.
function isBoothBusy() {
  if (state.screen === 'camera') return state.countdownRunning;
  if (state.screen === 'printcopies') return printCopiesConfirmButton.disabled;
  if (state.screen === 'scan') return state.qrLoading;
  return false;
}

// Called on every touch and every screen change: starts the wait over again.
function restartIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const timeoutMs = IDLE_TIMEOUTS[state.screen];
  if (!timeoutMs) return;
  idleTimer = setTimeout(() => {
    if (isBoothBusy()) restartIdleTimer();
    else resetSession();
  }, timeoutMs);
}

function startSession() {
  if (state.screen !== 'start' || startTransitionTimer) return;
  const startScreen = document.querySelector('[data-screen="start"]');
  startScreen.classList.remove('is-dragging');
  startScreen.classList.add('is-leaving');
  startTransitionTimer = setTimeout(() => {
    startTransitionTimer = null;
    startScreen.classList.remove('is-leaving');
    showScreen('shots');
  }, 450);
}

function notify(message, durationMs = 3500) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), durationMs);
}

async function initCamera() {
  stopCamera();
  updateCameraBackButton();
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMessage.textContent = 'Camera access is not supported in this browser.';
    notify('Camera access is not supported in this browser.');
    return false;
  }
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
    video.srcObject = state.cameraStream;
    await video.play();
    updateCameraMessage();
    return true;
  } catch (error) {
    state.cameraStream = null;
    cameraMessage.textContent = 'We could not access the camera.';
    notify('Please allow camera access, then try again.');
    return false;
  }
}

function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  video.srcObject = null;
}

// Going back is only offered before shooting starts. Once the countdown is
// running or a shot has been taken, the sequence runs to the preview screen,
// where "Try Again" is the way to redo it.
function updateCameraBackButton() {
  cameraBackButton.disabled = state.countdownRunning || state.capturedPhotos.length > 0;
}

function updateCameraMessage() {
  cameraMessage.textContent = `Shot ${state.capturedPhotos.length + 1} of ${state.photoCount} — camera is ready.`;
}

function selectShotCount(photoCount) {
  state.photoCount = photoCount;
  state.frame = FRAME_LAYOUTS[photoCount].src;
  state.capturedPhotos = [];
  document.querySelectorAll('.shot-option').forEach((button) => button.classList.toggle('selected', Number(button.dataset.photocount) === photoCount));
}

function confirmShotSelection() {
  if (!state.photoCount) return notify('Choose how many shots first.');
  syncServerSession({ photoCount: state.photoCount, frame: state.frame, state: 'SELECT_SHOTS' });
  updateCameraFraming();
  showScreen('camera');
  initCamera();
}

function clearCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownRunning = false;
  countdown.textContent = '';
  updateCameraBackButton();
}

function startCountdown() {
  if (state.countdownRunning || !state.cameraStream) return;
  state.countdownRunning = true;
  updateCameraBackButton();
  const moments = ['3', '2', '1'];
  let index = 0;
  const tick = () => {
    countdown.textContent = moments[index] || '';
    if (index === moments.length) {
      clearCountdown();
      capturePhotoStep();
      return;
    }
    index += 1;
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

// Works out which part of the camera picture goes into one photo slot.
// Step 1 takes a 4:5 portrait view of the camera, zoomed in by CAMERA_ZOOM.
// Step 2 trims that view to the slot's shape. Both the live camera box
// (updateCameraFraming) and the saved photo (captureSlotPhoto) use this, so
// the print matches what the guest saw.
function drawCover(source, targetWidth, targetHeight, zoom = 1) {
  let sourceWidth = Math.min(source.videoWidth, source.videoHeight * CAMERA_PREVIEW_RATIO) / zoom;
  let sourceHeight = sourceWidth / CAMERA_PREVIEW_RATIO;
  const targetRatio = targetWidth / targetHeight;
  if (targetRatio > CAMERA_PREVIEW_RATIO) {
    sourceHeight = sourceWidth / targetRatio;
  } else {
    sourceWidth = sourceHeight * targetRatio;
  }
  const sourceX = (source.videoWidth - sourceWidth) / 2;
  const sourceY = (source.videoHeight - sourceHeight) / 2;
  return { sourceX, sourceY, sourceWidth, sourceHeight };
}

// Shapes the live camera box like the photo slot of the chosen frame and zooms
// the video so the box shows exactly the area drawCover() will save.
function updateCameraFraming() {
  const layout = FRAME_LAYOUTS[state.photoCount];
  if (!layout) return;
  const slot = layout.slots[0];
  const slotRatio = slot.width / slot.height;
  cameraStage.style.setProperty('--stage-ratio', slotRatio);
  if (!video.videoWidth) return;
  // object-fit: cover already fills the box; this is how much of the camera's
  // width it shows before any zoom.
  const coverWidth = Math.min(video.videoWidth, video.videoHeight * slotRatio);
  const crop = drawCover(video, slot.width, slot.height, CAMERA_ZOOM);
  document.documentElement.style.setProperty('--camera-zoom', coverWidth / crop.sourceWidth);
}

function flashCamera() {
  if (!cameraFlash) return;
  cameraFlash.classList.add('is-active');
  requestAnimationFrame(() => requestAnimationFrame(() => cameraFlash.classList.remove('is-active')));
}

function captureSlotPhoto(slot) {
  const slotCanvas = document.createElement('canvas');
  slotCanvas.width = slot.width;
  slotCanvas.height = slot.height;
  const context = slotCanvas.getContext('2d');
  const crop = drawCover(video, slot.width, slot.height, CAMERA_ZOOM);
  context.save();
  context.filter = `brightness(${CAMERA_BRIGHTNESS})`;
  context.translate(slot.width, 0);
  context.scale(-1, 1);
  context.drawImage(video, crop.sourceX, crop.sourceY, crop.sourceWidth, crop.sourceHeight, 0, 0, slot.width, slot.height);
  context.restore();
  return slotCanvas;
}

function loadFrameImage(src) {
  return new Promise((resolve, reject) => {
    const frameImage = new Image();
    frameImage.onload = () => resolve(frameImage);
    frameImage.onerror = () => reject(new Error('Frame could not be loaded'));
    frameImage.src = src;
  });
}

async function composeFinalPhoto() {
  const layout = FRAME_LAYOUTS[state.photoCount];
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, layout.width, layout.height);
  state.capturedPhotos.forEach((slotCanvas, index) => {
    const slot = layout.slots[index];
    context.drawImage(slotCanvas, slot.x, slot.y, slot.width, slot.height);
  });
  try {
    const frameImage = await loadFrameImage(layout.src);
    context.drawImage(frameImage, 0, 0, layout.width, layout.height);
  } catch (error) {
    notify('Frame asset unavailable.');
  }
  state.composedPhoto = canvas.toDataURL('image/png');
  preview.src = state.composedPhoto;
  previewWraps.forEach((wrap) => { wrap.style.aspectRatio = `${layout.width} / ${layout.height}`; });
  if (state.serverSessionId) {
    apiRequest(`/api/sessions/${state.serverSessionId}/photo`, { method: 'POST', body: JSON.stringify({ photo: state.composedPhoto }) });
  }
}

async function capturePhotoStep() {
  if (!state.cameraStream || !video.videoWidth) {
    notify('The camera is not ready yet.');
    return;
  }
  try {
    const layout = FRAME_LAYOUTS[state.photoCount];
    const slot = layout.slots[state.capturedPhotos.length];
    state.capturedPhotos.push(captureSlotPhoto(slot));
    restartIdleTimer();
    updateCameraBackButton();
    flashCamera();
    if (state.capturedPhotos.length < state.photoCount) {
      updateCameraMessage();
      setTimeout(startCountdown, 700);
      return;
    }
    await composeFinalPhoto();
    stopCamera();
    showScreen('preview');
  } catch (error) {
    notify('We could not capture the photo. Please try again.');
  }
}

// Asks the server about a session again and again until isSettled(session) says
// the wait is over, then gives back that session. A request that fails (a WiFi
// hiccup) is simply tried again. Gives back null if time runs out, or if the
// guest has left this session in the meantime.
async function pollSession(sessionId, isSettled, { timeoutMs, intervalMs = 400 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Give up on a request that hangs, so one stuck request cannot use up the whole wait.
    const options = AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {};
    const result = await apiRequest(`/api/sessions/${sessionId}`, options, { quiet: true });
    if (state.serverSessionId !== sessionId) return null;
    if (result && isSettled(result.session)) return result.session;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// Runs alongside the QR screen: if the print job turns out to have failed, tell
// the guest instead of leaving them waiting for paper that will not come out.
async function watchPrintResult(sessionId) {
  const session = await pollSession(sessionId, (item) => item.print !== 'PROCESSING', { timeoutMs: PRINT_WAIT_MS, intervalMs: 1000 });
  if (session?.print !== 'FAILED') return;
  scanNotice.hidden = false;
  scanFootnote.hidden = true;
}

function renderQrBox(box, qrCode, altText) {
  box.innerHTML = '';
  if (qrCode) {
    const qrImage = document.createElement('img');
    qrImage.src = qrCode;
    qrImage.alt = altText;
    box.appendChild(qrImage);
  } else {
    box.textContent = 'ขออภัย สร้าง QR ไม่สำเร็จ อินเทอร์เน็ตของตู้อาจมีปัญหา';
  }
}

async function showPrintingComplete() {
  printingTimer = null;
  const sessionId = state.serverSessionId;
  scanNotice.hidden = true;
  scanFootnote.hidden = false;
  scanQrBoxColor.innerHTML = '';
  scanQrBoxColor.textContent = 'Preparing your QR code...';
  scanQrBoxBw.innerHTML = '';
  scanQrBoxBw.textContent = 'Preparing your QR code...';
  state.qrLoading = true;
  showScreen('scan');

  if (sessionId) watchPrintResult(sessionId);
  const result = sessionId ? await pollSession(sessionId, (item) => item.uploadStatus !== 'PROCESSING', { timeoutMs: QR_WAIT_MS }) : null;
  // The guest went back to the start screen while the QR codes were loading.
  if (state.serverSessionId !== sessionId) return;
  state.qrLoading = false;
  // Count the idle wait from when the QR codes actually appear.
  restartIdleTimer();
  renderQrBox(scanQrBoxColor, result?.qrCode, 'Scan to download your color photo');
  renderQrBox(scanQrBoxBw, result?.qrCodeBw, 'Scan to download your black and white photo');
}

function updatePrintCopiesUI() {
  printCopiesValue.textContent = `${state.printCopies} Print${state.printCopies > 1 ? 's' : ''}`;
  printCopiesMinus.disabled = state.printCopies <= 1;
  printCopiesPlus.disabled = state.printCopies >= MAX_PRINT_COPIES;
}

function resetSession() {
  clearTimeout(printingTimer);
  printingTimer = null;
  clearCountdown();
  stopCamera();
  state.screen = 'start';
  state.photoCount = null;
  state.frame = null;
  state.capturedPhotos = [];
  state.composedPhoto = null;
  state.printCopies = 1;
  state.serverSessionId = null;
  state.serverSessionPromise = null;
  state.qrLoading = false;
  canvas.width = 0;
  canvas.height = 0;
  preview.removeAttribute('src');
  printCopiesPreview.removeAttribute('src');
  printCopiesConfirmButton.disabled = false;
  previewWraps.forEach((wrap) => { wrap.style.aspectRatio = ''; });
  updatePrintCopiesUI();
  document.querySelectorAll('.selected').forEach((item) => item.classList.remove('selected'));
  showScreen('start');
}

startScreen.addEventListener('pointerdown', (event) => {
  if (state.screen !== 'start') return;
  touchStartY = event.clientY;
  touchDistance = 0;
  startScreen.setPointerCapture(event.pointerId);
  startScreen.classList.add('is-dragging');
}, { passive: true });
startScreen.addEventListener('pointermove', (event) => {
  if (state.screen !== 'start' || touchStartY === null) return;
  touchDistance = Math.max(0, touchStartY - event.clientY);
  startScreen.style.transform = `translateY(-${Math.min(touchDistance, window.innerHeight * 0.5)}px)`;
  event.preventDefault();
}, { passive: false });
startScreen.addEventListener('pointerup', (event) => {
  if (state.screen !== 'start' || touchStartY === null) return;
  const swipeDistance = Math.max(touchDistance, touchStartY - event.clientY);
  touchStartY = null;
  touchDistance = 0;
  startScreen.releasePointerCapture(event.pointerId);
  startScreen.classList.remove('is-dragging');
  startScreen.style.transform = '';
  if (swipeDistance >= window.innerHeight * 0.35) startSession();
}, { passive: true });
startScreen.addEventListener('pointercancel', () => {
  touchStartY = null;
  touchDistance = 0;
  startScreen.classList.remove('is-dragging');
  startScreen.style.transform = '';
}, { passive: true });
startScreen.addEventListener('click', startSession);
document.querySelector('#shotGrid').addEventListener('click', (event) => { const option = event.target.closest('[data-photocount]'); if (option) selectShotCount(Number(option.dataset.photocount)); });
document.querySelector('#shotsNextButton').addEventListener('click', confirmShotSelection);
document.querySelector('#shotsBackButton').addEventListener('click', resetSession);
cameraBackButton.addEventListener('click', () => {
  if (cameraBackButton.disabled) return;
  showScreen('shots');
});
document.querySelector('#captureButton').addEventListener('click', startCountdown);
// The camera's picture size is only known once the video starts, and changes if the iPad is rotated.
video.addEventListener('loadedmetadata', updateCameraFraming);
video.addEventListener('resize', updateCameraFraming);
document.querySelector('#retakeButton').addEventListener('click', () => {
  state.capturedPhotos = [];
  showScreen('camera');
  initCamera();
});
document.querySelector('#confirmButton').addEventListener('click', () => {
  if (!state.composedPhoto) return notify('There is no captured photo to confirm.');
  state.printCopies = 1;
  updatePrintCopiesUI();
  printCopiesPreview.src = state.composedPhoto;
  syncServerSession({ state: 'SELECT_PRINT_COPIES' });
  showScreen('printcopies');
});
printCopiesMinus.addEventListener('click', () => {
  if (state.printCopies <= 1) return;
  state.printCopies -= 1;
  updatePrintCopiesUI();
});
printCopiesPlus.addEventListener('click', () => {
  if (state.printCopies >= MAX_PRINT_COPIES) return;
  state.printCopies += 1;
  updatePrintCopiesUI();
});
const printCopiesConfirmButton = document.querySelector('#printCopiesConfirmButton');
printCopiesConfirmButton.addEventListener('click', async () => {
  if (printCopiesConfirmButton.disabled) return;
  printCopiesConfirmButton.disabled = true;
  const transactionData = { photoCount: state.photoCount, frame: state.frame, printCopies: state.printCopies, photo: state.composedPhoto };
  console.info('Prototype transaction ready:', transactionData);
  if (state.serverSessionId) {
    const result = await apiRequest(`/api/sessions/${state.serverSessionId}/print`, { method: 'POST', body: JSON.stringify({ printCopies: state.printCopies }) });
    if (!result) {
      printCopiesConfirmButton.disabled = false;
      return;
    }
    // Nothing is printing, so skip the "Printing..." screen and go straight to the QR codes.
    if (result.session.print === 'FAILED') return showPrintingComplete();
  }
  showScreen('printing');
  printingTimer = setTimeout(showPrintingComplete, 3200);
});
document.querySelector('#printCopiesBackButton').addEventListener('click', () => {
  // Once Confirm has been pressed the print job is already on its way.
  if (printCopiesConfirmButton.disabled) return;
  syncServerSession({ state: 'PREVIEW' });
  showScreen('preview');
});
document.querySelector('#scanContinueButton').addEventListener('click', resetSession);
document.querySelector('#resetButton').addEventListener('click', resetSession);
document.addEventListener('pointerdown', restartIdleTimer, { capture: true, passive: true });
document.addEventListener('keydown', restartIdleTimer, { capture: true });
window.addEventListener('pagehide', () => { clearCountdown(); stopCamera(); });
