const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEVICE_PATH = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
const PRINT_WIDTH_DOTS = 576; // 80mm paper, 203dpi thermal head, ~72mm printable width
const WIDTH_BYTES = PRINT_WIDTH_DOTS / 8;
// The printer sits in the cabinet so that paper feeds out toward the guest
// bottom-edge first, so the image is rotated 180 degrees to come out upright.
// Set PRINT_ROTATE_180=false in .env if the printer is ever remounted the other way.
const ROTATE_180 = process.env.PRINT_ROTATE_180 !== 'false';

// Tone curve applied just before dithering, as [input brightness, output brightness]
// points (0 = black, 255 = white) joined by straight lines. It lifts the dark and
// middle tones (hair, shaded skin, wood, backgrounds), which thermal paper prints
// darker than they look on screen, while leaving near-black (text, frame lines)
// and near-white (shirts, walls) almost untouched so whites keep their detail.
const TONE_CURVE = [[0, 0], [30, 33], [70, 91], [110, 132], [150, 166], [200, 207], [225, 228], [255, 255]];

function buildToneLut(points) {
  const lut = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    const upper = points.findIndex(([input]) => input >= value);
    const [x1, y1] = points[upper];
    const [x0, y0] = points[Math.max(upper - 1, 0)];
    lut[value] = x1 === x0 ? y1 : Math.round(y0 + ((y1 - y0) * (value - x0)) / (x1 - x0));
  }
  return lut;
}

const TONE_LUT = buildToneLut(TONE_CURVE);

// Frame artwork (titles, menu text, borders, barcode) is never toned or dithered:
// any frame pixel darker than this prints solid black, the rest stays blank paper,
// so lettering comes out dark with clean edges. Only the photo slots (the
// transparent holes in the frame PNG) go through the photo tone steps.
const FRAME_INK_THRESHOLD = 170;
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Returns one byte per print dot: 255 where the frame PNG covers the paper,
// 0 inside the photo slots. Null if the frame is missing or does not line up.
async function loadFrameMask(framePath, width, height) {
  if (!framePath) return null;
  const resolved = path.resolve(ASSETS_DIR, '..', framePath);
  if (!resolved.startsWith(ASSETS_DIR + path.sep) || !fs.existsSync(resolved)) return null;
  const { data, info } = await sharp(resolved)
    .ensureAlpha()
    .extractChannel('alpha')
    .rotate(ROTATE_180 ? 180 : 0)
    .resize({ width: PRINT_WIDTH_DOTS })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return info.width === width && info.height === height ? data : null;
}

const ESC_INIT = Buffer.from([0x1b, 0x40]);
const CUT = Buffer.from([0x1d, 0x56, 0x01]);
const FEED = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a]);

// Serpentine (boustrophedon) scan: alternating scan direction per row cancels out
// the diagonal "worm trail" streaking that plain left-to-right Floyd-Steinberg
// leaves in flat midtone areas like skin and walls.
function floydSteinbergDither(pixels, width, height) {
  const values = Float32Array.from(pixels);
  const at = (x, y) => y * width + x;
  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0;
    const dir = leftToRight ? 1 : -1;
    const xStart = leftToRight ? 0 : width - 1;
    const xStop = leftToRight ? width : -1;
    for (let x = xStart; x !== xStop; x += dir) {
      const index = at(x, y);
      const old = values[index];
      const newValue = old < 128 ? 0 : 255;
      const error = old - newValue;
      values[index] = newValue;
      const fx = x + dir;
      const bx = x - dir;
      if (fx >= 0 && fx < width) values[at(fx, y)] += (error * 7) / 16;
      if (bx >= 0 && bx < width && y + 1 < height) values[at(bx, y + 1)] += (error * 3) / 16;
      if (y + 1 < height) values[at(x, y + 1)] += (error * 5) / 16;
      if (fx >= 0 && fx < width && y + 1 < height) values[at(fx, y + 1)] += (error * 1) / 16;
    }
  }
  return values;
}

function packBits(ditheredValues, width, height) {
  const packed = Buffer.alloc(WIDTH_BYTES * height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isBlack = ditheredValues[y * width + x] < 128;
      if (isBlack) packed[y * WIDTH_BYTES + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return packed;
}

async function ditherForPrint(dataUrl, framePath) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const inputBuffer = Buffer.from(base64, 'base64');
  const sized = sharp(inputBuffer)
    .flatten({ background: '#ffffff' })
    .rotate(ROTATE_180 ? 180 : 0)
    .resize({ width: PRINT_WIDTH_DOTS })
    .grayscale();
  const untouched = await sized.clone().raw().toBuffer();
  const { data, info } = await sized
    .median(3)
    .clahe({ width: 32, height: 32, maxSlope: 1 })
    .gamma(1.6)
    .linear(1.0, 12)
    .sharpen({ sigma: 1.2, m1: 1.8, m2: 3.5 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 0; index < data.length; index++) data[index] = TONE_LUT[data[index]];

  const width = info.width;
  const height = info.height;
  const frameMask = await loadFrameMask(framePath, width, height);
  if (frameMask) {
    for (let index = 0; index < data.length; index++) {
      if (frameMask[index] >= 128) data[index] = untouched[index] < FRAME_INK_THRESHOLD ? 0 : 255;
    }
  }
  const dithered = floydSteinbergDither(data, width, height);
  return { dithered, width, height };
}

async function dataUrlToRaster(dataUrl, framePath) {
  const { dithered, width, height } = await ditherForPrint(dataUrl, framePath);
  const packed = packBits(dithered, width, height);

  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    WIDTH_BYTES & 0xff, (WIDTH_BYTES >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff
  ]);
  return Buffer.concat([header, packed]);
}

let printQueue = Promise.resolve();

async function printPhoto(dataUrl, copies = 1, framePath) {
  const raster = await dataUrlToRaster(dataUrl, framePath);
  const receipt = Buffer.concat([ESC_INIT, raster, FEED, CUT]);
  const job = Buffer.concat(Array(copies).fill(receipt));
  // Written in the background: the printer takes the data only as fast as it
  // prints, and a blocking write would freeze the whole server meanwhile
  // (stalling the photo upload and the iPad's requests for its QR codes).
  // One job at a time: a long multi-copy job can still be printing when the next
  // guest confirms, and two writes at once would interleave into garbage.
  const write = printQueue.then(() => fs.promises.writeFile(DEVICE_PATH, job));
  printQueue = write.catch(() => {});
  await write;
}

function isReady() {
  return fs.existsSync(DEVICE_PATH);
}

module.exports = { printPhoto, isReady, ditherForPrint };
