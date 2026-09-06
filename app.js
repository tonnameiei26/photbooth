const state = {
  screen: 'start',
  quantity: null,
  price: null,
  frame: null,
  photo: null,
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
const cameraMessage = document.querySelector('#cameraMessage');
const toast = document.querySelector('#toast');
const sessionLabel = document.querySelector('#sessionLabel');
const paymentAmount = document.querySelector('#paymentAmount');
const paymentStatus = document.querySelector('#paymentStatus');
const paymentButton = document.querySelector('#mockPaymentButton');
const printingScreen = document.querySelector('[data-screen="printing"]');
const printingEyebrow = document.querySelector('#printingEyebrow');
const printingTitle = document.querySelector('#printingTitle');
const printingCopy = document.querySelector('#printingCopy');
const printingStamp = document.querySelector('#printingStamp');
const printingVideo = document.querySelector('#printingVideo');
const printingProgress = document.querySelector('#printingProgress');
const startScreen = document.querySelector('[data-screen="start"]');
const prices = { 1: 50, 2: 100, 3: 150, 4: 200 };
let touchStartY = null;
let touchDistance = 0;
let toastTimer = null;
let startTransitionTimer = null;

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
  sessionLabel.textContent = screenName === 'start' ? 'READY WHEN YOU ARE' : `${screenName.toUpperCase()} / RPB`;
  if (screenName !== 'camera') stopCamera();
  if (screenName === 'frame') frameSwiper.update();
}

function startSession() {
  if (state.screen !== 'start' || startTransitionTimer) return;
  const startScreen = document.querySelector('[data-screen="start"]');
  startScreen.classList.remove('is-dragging');
  startScreen.classList.add('is-leaving');
  startTransitionTimer = setTimeout(() => {
    startTransitionTimer = null;
    startScreen.classList.remove('is-leaving');
    showScreen('quantity');
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
    cameraMessage.textContent = 'Camera is ready.';
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

function selectQuantity(quantity) {
  state.quantity = quantity;
  state.price = prices[quantity];
  document.querySelectorAll('.quantity-option').forEach((button) => button.classList.toggle('selected', Number(button.dataset.quantity) === quantity));
  document.querySelector('#quantitySummary').textContent = `${quantity} ${quantity === 1 ? 'print' : 'prints'} / ฿${state.price}`;
  syncServerSession({ quantity, state: 'SELECT_QUANTITY' });
  setTimeout(() => showScreen('frame'), 180);
}

const FRAMES = [
  { src: 'assets/pic1.png', thumb: 'assets/thumbs/pic1-thumb.png', label: 'Frame 01' },
  { src: 'assets/pic2.png', thumb: 'assets/thumbs/pic2-thumb.png', label: 'Frame 02' },
  { src: 'assets/pic3.png', thumb: 'assets/thumbs/pic3-thumb.png', label: 'Frame 03' }
];
// Swiper's infinite loop needs enough real slides to work with, or it silently
// disables looping when there are only a handful of wide, centered slides.
// Repeating the same 3 frames a few times keeps looping seamless either direction.
// The carousel shows lightweight thumbnails (not the full print-resolution PNGs)
// so swiping stays smooth on the iPad; capturePhoto() still composites the
// full-resolution frame from data-frame when the photo is actually printed.
const FRAME_LOOP_REPEATS = 3;
document.querySelector('#frameSwiperWrapper').innerHTML = Array.from({ length: FRAME_LOOP_REPEATS })
  .flatMap(() => FRAMES)
  .map(({ src, thumb, label }) => `<div class="swiper-slide frame-slide" data-frame="${src}"><span class="frame-slide-card"><img src="${thumb}" alt="${label}" draggable="false"></span><b class="frame-slide-label">${label}</b></div>`)
  .join('');

function trackActiveFrame(swiper) {
  const activeSlide = swiper.slides[swiper.activeIndex];
  if (activeSlide?.dataset.frame) state.frame = activeSlide.dataset.frame;
}

const frameSwiper = new Swiper('#frameSwiper', {
  effect: 'coverflow',
  loop: true,
  centeredSlides: true,
  slidesPerView: 'auto',
  grabCursor: true,
  coverflowEffect: { rotate: 32, stretch: 0, depth: 160, modifier: 1, slideShadows: false },
  on: { init: trackActiveFrame, slideChangeTransitionEnd: trackActiveFrame }
});

function confirmFrame() {
  if (!state.frame) return notify('Swipe to choose a frame first.');
  paymentAmount.textContent = `฿${state.price || 0}`;
  paymentStatus.textContent = 'WAITING FOR PAYMENT';
  paymentStatus.classList.remove('is-paid');
  paymentButton.disabled = false;
  syncServerSession({ frame: state.frame, state: 'WAIT_PAYMENT' });
  showScreen('payment');
}

async function completeMockPayment() {
  paymentButton.disabled = true;
  paymentStatus.textContent = 'CHECKING PAYMENT...';
  const sessionId = await ensureServerSession();
  const result = sessionId ? await apiRequest(`/api/sessions/${sessionId}/payment/mock`, { method: 'POST', body: '{}' }) : null;
  if (!result) {
    paymentButton.disabled = false;
    paymentStatus.textContent = 'PAYMENT FAILED';
    return;
  }
  paymentStatus.textContent = 'PAYMENT SUCCESS';
  paymentStatus.classList.add('is-paid');
  setTimeout(() => { showScreen('camera'); initCamera(); }, 500);
}

function showPrintingComplete() {
  printingVideo.hidden = true;
  printingScreen.classList.remove('is-video-playing');
  printingScreen.classList.add('is-done');
  printingEyebrow.textContent = 'MOCK PRINTER / DONE';
  printingTitle.innerHTML = 'Your photo is<br><em>ready.</em>';
  printingCopy.textContent = 'Mock print completed successfully. The real printer can replace this service later.';
  printingStamp.innerHTML = 'RPB<br>OK';
  showScreen('thankyou');
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
      capturePhoto();
      return;
    }
    index += 1;
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function drawCover(source, targetWidth, targetHeight) {
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
  return { sourceX, sourceY, sourceWidth, sourceHeight };
}

function drawFrameOverlay(context, width, height) {
  const frameNumber = state.frame?.match(/frame(\d)/)?.[1] || '1';
  const palettes = { 1: ['#e85d46', '#f0d9bd'], 2: ['#173f52', '#a9c3c4'], 3: ['#e5a343', '#f4d08d'] };
  const [primary, secondary] = palettes[frameNumber];
  context.save();
  context.strokeStyle = primary;
  context.lineWidth = Math.max(width * .035, 24);
  context.strokeRect(context.lineWidth / 2, context.lineWidth / 2, width - context.lineWidth, height - context.lineWidth);
  context.strokeStyle = secondary;
  context.lineWidth = Math.max(width * .008, 5);
  context.strokeRect(width * .075, height * .075, width * .85, height * .85);
  context.fillStyle = primary;
  context.font = `600 ${Math.max(width * .026, 24)}px monospace`;
  context.fillText(`RPB / ${frameNumber.padStart(2, '0')}`, width * .09, height * .94);
  context.restore();
}

function loadFrameImage() {
  return new Promise((resolve, reject) => {
    if (!state.frame) {
      reject(new Error('No frame selected'));
      return;
    }
    const frameImage = new Image();
    frameImage.onload = () => resolve(frameImage);
    frameImage.onerror = () => reject(new Error('Frame could not be loaded'));
    frameImage.src = state.frame;
  });
}

async function capturePhoto() {
  if (!state.cameraStream || !video.videoWidth) {
    notify('The camera is not ready yet.');
    return;
  }
  try {
    const width = 945;
    const height = 1772;
    const photoWindow = { x: 141, y: 257, width: 663, height: 666 };
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const crop = drawCover(video, photoWindow.width, photoWindow.height);
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, crop.sourceX, crop.sourceY, crop.sourceWidth, crop.sourceHeight, width - photoWindow.x - photoWindow.width, photoWindow.y, photoWindow.width, photoWindow.height);
    context.restore();
    try {
      const frameImage = await loadFrameImage();
      context.drawImage(frameImage, 0, 0, width, height);
    } catch (error) {
      drawFrameOverlay(context, width, height);
      notify('Frame asset unavailable. Using the built-in frame.');
    }
    state.photo = canvas.toDataURL('image/png');
    preview.src = state.photo;
    if (state.serverSessionId) {
      apiRequest(`/api/sessions/${state.serverSessionId}/photo`, { method: 'POST', body: JSON.stringify({ photo: state.photo }) });
    }
    stopCamera();
    showScreen('preview');
  } catch (error) {
    notify('We could not capture the photo. Please try again.');
  }
}

function resetSession() {
  clearCountdown();
  stopCamera();
  printingVideo.pause();
  printingVideo.currentTime = 0;
  state.screen = 'start';
  state.quantity = null;
  state.price = null;
  state.frame = null;
  state.photo = null;
  state.serverSessionId = null;
  state.serverSessionPromise = null;
  frameSwiper.slideToLoop(0, 0, false);
  trackActiveFrame(frameSwiper);
  printingScreen.classList.remove('is-done');
  printingScreen.classList.remove('is-video-playing');
  printingEyebrow.textContent = 'MOCK PRINTER';
  printingTitle.innerHTML = 'Printing your<br><em>keepsake.</em>';
  printingCopy.textContent = 'Sending your photo to the simulated printer...';
  printingStamp.innerHTML = 'RPB<br>...';
  canvas.width = 0;
  canvas.height = 0;
  preview.removeAttribute('src');
  document.querySelectorAll('.selected').forEach((item) => item.classList.remove('selected'));
  document.querySelector('#quantitySummary').textContent = 'Choose a quantity to continue';
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
document.querySelector('#quantityGrid').addEventListener('click', (event) => { const option = event.target.closest('[data-quantity]'); if (option) selectQuantity(Number(option.dataset.quantity)); });
document.querySelector('#frameConfirmButton').addEventListener('click', confirmFrame);
paymentButton.addEventListener('click', completeMockPayment);
document.querySelector('#captureButton').addEventListener('click', startCountdown);
document.querySelector('#retakeButton').addEventListener('click', () => { showScreen('camera'); initCamera(); });
document.querySelector('#confirmButton').addEventListener('click', async () => {
  if (!state.photo) return notify('There is no captured photo to confirm.');
  const transactionData = { quantity: state.quantity, price: state.price, frame: state.frame, photo: state.photo };
  console.info('Prototype transaction ready:', transactionData);
  if (state.serverSessionId) {
    const result = await apiRequest(`/api/sessions/${state.serverSessionId}/print`, { method: 'POST', body: '{}' });
    if (!result) return;
  }
  showScreen('printing');
  printingScreen.classList.add('is-video-playing');
  printingVideo.currentTime = 0;
  printingVideo.hidden = false;
  printingProgress.hidden = true;
  printingVideo.play().catch(() => {
    printingScreen.classList.remove('is-video-playing');
    printingVideo.hidden = true;
    printingProgress.hidden = false;
    setTimeout(showPrintingComplete, 3200);
  });
});
printingVideo.addEventListener('ended', () => setTimeout(showPrintingComplete, 250));
printingVideo.addEventListener('error', () => {
  printingScreen.classList.remove('is-video-playing');
  printingVideo.hidden = true;
  printingProgress.hidden = false;
  setTimeout(showPrintingComplete, 3200);
});
document.querySelector('#resetButton').addEventListener('click', resetSession);
document.querySelector('#thankyouResetButton').addEventListener('click', resetSession);
window.addEventListener('pagehide', () => { clearCountdown(); stopCamera(); });
