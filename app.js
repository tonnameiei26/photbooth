const CAMERA_ZOOM = 1.35;
const CAMERA_BRIGHTNESS = 1;
document.documentElement.style.setProperty('--camera-zoom', CAMERA_ZOOM);
document.documentElement.style.setProperty('--camera-brightness', CAMERA_BRIGHTNESS);

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
  serverSessionPromise: null
};

const screens = [...document.querySelectorAll('[data-screen]')];
const video = document.querySelector('#webcamVideo');
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
const previewWraps = document.querySelectorAll('.photo-preview-wrap');
let touchStartY = null;
let touchDistance = 0;
let toastTimer = null;
let startTransitionTimer = null;

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

async function apiRequest(endpoint, options = {}) {
  try {
    const response = await fetch(endpoint, { headers: { 'Content-Type': 'application/json' }, ...options });
    const responseText = await response.text();
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      throw new Error('Backend response was not valid JSON');
    }
    if (!response.ok) throw new Error(payload.error || 'Server request failed');
    return payload;
  } catch (error) {
    notify(`Server unavailable: ${error.message}`);
    return null;
  }
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

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

async function initCamera() {
  stopCamera();
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
  showScreen('camera');
  initCamera();
}

function clearCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownRunning = false;
  countdown.textContent = '';
}

function startCountdown() {
  if (state.countdownRunning || !state.cameraStream) return;
  state.countdownRunning = true;
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

function drawCover(source, targetWidth, targetHeight, zoom = 1) {
  const sourceRatio = source.videoWidth / source.videoHeight;
  const targetRatio = targetWidth / targetHeight;
  let sourceWidth = source.videoWidth;
  let sourceHeight = source.videoHeight;
  let sourceX = 0;
  let sourceY = 0;
  if (sourceRatio > targetRatio) {
    sourceWidth = source.videoHeight * targetRatio;
    sourceX = (source.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = source.videoWidth / targetRatio;
    sourceY = (source.videoHeight - sourceHeight) / 2;
  }
  if (zoom > 1) {
    const zoomedWidth = sourceWidth / zoom;
    const zoomedHeight = sourceHeight / zoom;
    sourceX += (sourceWidth - zoomedWidth) / 2;
    sourceY += (sourceHeight - zoomedHeight) / 2;
    sourceWidth = zoomedWidth;
    sourceHeight = zoomedHeight;
  }
  return { sourceX, sourceY, sourceWidth, sourceHeight };
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

async function pollForQrCode(sessionId, { attempts = 20, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await apiRequest(`/api/sessions/${sessionId}`);
    if (!result) return null;
    if (result.session.uploadStatus === 'DONE') return { qrCode: result.session.qrCode, qrCodeBw: result.session.qrCodeBw };
    if (result.session.uploadStatus === 'FAILED') return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function renderQrBox(box, qrCode, altText) {
  box.innerHTML = '';
  if (qrCode) {
    const qrImage = document.createElement('img');
    qrImage.src = qrCode;
    qrImage.alt = altText;
    box.appendChild(qrImage);
  } else {
    box.textContent = 'QR code unavailable. Please ask staff for help.';
  }
}

async function showPrintingComplete() {
  scanQrBoxColor.innerHTML = '';
  scanQrBoxColor.textContent = 'Preparing your QR code...';
  scanQrBoxBw.innerHTML = '';
  scanQrBoxBw.textContent = 'Preparing your QR code...';
  showScreen('scan');

  const result = state.serverSessionId ? await pollForQrCode(state.serverSessionId) : null;
  renderQrBox(scanQrBoxColor, result?.qrCode, 'Scan to download your color photo');
  renderQrBox(scanQrBoxBw, result?.qrCodeBw, 'Scan to download your black and white photo');
}

function updatePrintCopiesUI() {
  printCopiesValue.textContent = `${state.printCopies} Print${state.printCopies > 1 ? 's' : ''}`;
  printCopiesMinus.disabled = state.printCopies <= 1;
  printCopiesPlus.disabled = state.printCopies >= 4;
}

function resetSession() {
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
document.querySelector('#captureButton').addEventListener('click', startCountdown);
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
  if (state.printCopies >= 4) return;
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
  }
  showScreen('printing');
  setTimeout(showPrintingComplete, 3200);
});
document.querySelector('#scanContinueButton').addEventListener('click', resetSession);
document.querySelector('#resetButton').addEventListener('click', resetSession);
window.addEventListener('pagehide', () => { clearCountdown(); stopCamera(); });
