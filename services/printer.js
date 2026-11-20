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

// Print tone presets, picked with PRINT_TONE in .env (then pm2 restart photobooth).
// "baseline" is the setting locked in on 2026-10-03 and stays exactly as it was:
// set PRINT_TONE=baseline (or remove the line) to go back to it at any time.
// The brighter presets were added on 2026-11-18 because faces printed too dark
// in front of a white wall: the iPad camera exposes for the bright wall, so the
// face is already dark in the photo. They make two changes to the photo slots:
//  - greyMix: turns colour into grey with more weight on red, like a red filter
//    in black-and-white film photography. Skin is mostly red so it comes out
//    lighter, while white walls and grey or black things barely change.
//  - curve: a tone curve that lifts dark and middle tones more than TONE_CURVE.
// Sharpening used by every preset that does not set its own.
const DEFAULT_SHARPEN = { sigma: 1.2, m1: 1.8, m2: 3.5 };
const TONE_PRESETS = {
  baseline: { greyMix: null, curve: TONE_CURVE },
  brighter: {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 40], [70, 110], [110, 155], [150, 190], [200, 225], [225, 240], [255, 255]]
  },
  // Between baseline and "brighter", a little closer to "brighter" (user asked
  // for B "a touch darker" on 2026-11-18).
  'brighter-soft': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 37], [70, 103], [110, 147], [150, 183], [200, 220], [225, 236], [255, 255]]
  },
  // B2 with a little more sharpening, as test options (2026-11-18).
  'brighter-soft-sharp1': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 37], [70, 103], [110, 147], [150, 183], [200, 220], [225, 236], [255, 255]],
    sharpen: { sigma: 1.2, m1: 2.2, m2: 4.2 }
  },
  'brighter-soft-sharp2': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 37], [70, 103], [110, 147], [150, 183], [200, 220], [225, 236], [255, 255]],
    sharpen: { sigma: 1.2, m1: 2.6, m2: 5.0 }
  },
  // S1 sharpening with brighter curves, as test options (2026-11-19: faces
  // still a little dark at the first event).
  'light1-sharp1': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 40], [70, 110], [110, 155], [150, 190], [200, 225], [225, 240], [255, 255]],
    sharpen: { sigma: 1.2, m1: 2.2, m2: 4.2 }
  },
  'light2-sharp1': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 44], [70, 119], [110, 165], [150, 198], [200, 229], [225, 242], [255, 255]],
    sharpen: { sigma: 1.2, m1: 2.2, m2: 4.2 }
  },
  'light3-sharp1': {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 50], [70, 130], [110, 175], [150, 205], [200, 233], [225, 244], [255, 255]],
    sharpen: { sigma: 1.2, m1: 2.2, m2: 4.2 }
  },
  brightest: {
    greyMix: [0.5, 0.4, 0.1],
    curve: [[0, 0], [30, 50], [70, 130], [110, 175], [150, 205], [200, 233], [225, 244], [255, 255]]
  }
};
for (const preset of Object.values(TONE_PRESETS)) preset.lut = buildToneLut(preset.curve);
const ACTIVE_TONE = TONE_PRESETS[process.env.PRINT_TONE] ? process.env.PRINT_TONE : 'baseline';

// Frame artwork (titles, menu text, borders, barcode) is never toned or dithered:
// any frame pixel darker than this prints solid black, the rest stays blank paper,
// so lettering comes out dark with clean edges. Only the photo slots (the
// transparent holes in the frame PNG) go through the photo tone steps.
const FRAME_INK_THRESHOLD = 170;
// Colourful frame artwork (such as a light green logo) also prints solid black,
// however light it is, so a logo keeps its whole shape instead of losing its
// pale parts. A pixel counts as colourful when its strongest and weakest colour
// channels differ by more than this; greys, black and white never do.
const FRAME_COLOUR_THRESHOLD = 60;
// Thin coloured lettering (such as small gold text on white) blends with the
// paper when shrunk to print size and drops below that threshold. Mid-tone
// pixels with a weaker tint still count as colourful; bright cream/white
// artwork (a cream logo on a dark band) stays above FRAME_TINT_MAX_BRIGHTNESS
// so it keeps printing as blank paper.
const FRAME_TINT_THRESHOLD = 30;
const FRAME_TINT_MAX_BRIGHTNESS = 215;
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Returns one byte per print dot: 0 inside the photo slots, FRAME_PLAIN where
// the frame PNG covers the paper, FRAME_COLOUR where that frame pixel is
// colourful. Null if the frame is missing or does not line up.
const FRAME_PLAIN = 1;
const FRAME_COLOUR = 2;
async function loadFrameMask(framePath, width, height) {
  if (!framePath) return null;
  const resolved = path.resolve(ASSETS_DIR, '..', framePath);
  if (!resolved.startsWith(ASSETS_DIR + path.sep) || !fs.existsSync(resolved)) return null;
  const { data, info } = await sharp(resolved)
    .ensureAlpha()
    .rotate(ROTATE_180 ? 180 : 0)
    .resize({ width: PRINT_WIDTH_DOTS })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) return null;
  const mask = Buffer.alloc(width * height);
  for (let index = 0; index < mask.length; index++) {
    const [red, green, blue, alpha] = data.subarray(index * 4, index * 4 + 4);
    if (alpha < 128) continue;
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;
    const colourful = spread > FRAME_COLOUR_THRESHOLD || (spread > FRAME_TINT_THRESHOLD && brightness < FRAME_TINT_MAX_BRIGHTNESS);
    mask[index] = colourful ? FRAME_COLOUR : FRAME_PLAIN;
  }
  return mask;
}

const ESC_INIT = Buffer.from([0x1b, 0x40]);
const CUT = Buffer.from([0x1d, 0x56, 0x01]);
const FEED = Buffer.from([0x0a, 0x0a, 0x0a, 0x0a]);
// The cutter sits about 13mm above the print head and this printer cannot pull
// paper back (ESC e is ignored, tested 2026-11-20), so every receipt starts with
// that much blank paper before the image. Blank rows are printed after the image
// too, so the blank edges at both ends match instead of one end being flush and
// the other wide. (ESC J "feed n dots" was ignored by this printer, so the
// margin is sent as a block of white raster rows instead.) In print dots
// (8 dots = 1mm); 0 turns it off.
const TRAILING_MARGIN_DOTS = Math.max(0, Number(process.env.PRINT_TRAILING_MARGIN_DOTS ?? 96) || 0);
const TRAILING_MARGIN = TRAILING_MARGIN_DOTS
  ? Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, WIDTH_BYTES & 0xff, (WIDTH_BYTES >> 8) & 0xff, TRAILING_MARGIN_DOTS & 0xff, (TRAILING_MARGIN_DOTS >> 8) & 0xff]),
    Buffer.alloc(WIDTH_BYTES * TRAILING_MARGIN_DOTS, 0)
  ])
  : Buffer.alloc(0);

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

// Grey version of the photo for the tone steps. Baseline keeps sharp's own
// grayscale exactly as before; a preset with greyMix mixes red, green and blue
// with its own weights instead.
async function toneInput(sized, greyMix) {
  if (!greyMix) return sized.clone().grayscale();
  const { data, info } = await sized.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grey = Buffer.alloc(info.width * info.height);
  const [red, green, blue] = greyMix;
  for (let index = 0; index < grey.length; index++) {
    const at = index * info.channels;
    grey[index] = Math.min(255, Math.round(red * data[at] + green * data[at + 1] + blue * data[at + 2]));
  }
  // .grayscale() keeps the output one channel (sharp would otherwise return colour).
  return sharp(grey, { raw: { width: info.width, height: info.height, channels: 1 } }).grayscale();
}

async function ditherForPrint(dataUrl, framePath, toneName = ACTIVE_TONE) {
  const tone = TONE_PRESETS[toneName] || TONE_PRESETS.baseline;
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const inputBuffer = Buffer.from(base64, 'base64');
  const sized = sharp(inputBuffer)
    .flatten({ background: '#ffffff' })
    .rotate(ROTATE_180 ? 180 : 0)
    .resize({ width: PRINT_WIDTH_DOTS });
  const untouched = await sized.clone().grayscale().raw().toBuffer();
  const { data, info } = await (await toneInput(sized, tone.greyMix))
    .median(3)
    .clahe({ width: 32, height: 32, maxSlope: 1 })
    .gamma(1.6)
    .linear(1.0, 12)
    .sharpen(tone.sharpen || DEFAULT_SHARPEN)
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 0; index < data.length; index++) data[index] = tone.lut[data[index]];

  const width = info.width;
  const height = info.height;
  const frameMask = await loadFrameMask(framePath, width, height);
  if (frameMask) {
    for (let index = 0; index < data.length; index++) {
      if (frameMask[index] === FRAME_COLOUR) data[index] = 0;
      else if (frameMask[index] === FRAME_PLAIN) data[index] = untouched[index] < FRAME_INK_THRESHOLD ? 0 : 255;
    }
  }
  const dithered = floydSteinbergDither(data, width, height);
  return { dithered, width, height };
}

async function dataUrlToRaster(dataUrl, framePath, toneName) {
  const { dithered, width, height } = await ditherForPrint(dataUrl, framePath, toneName);
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
  const receipt = Buffer.concat([ESC_INIT, raster, TRAILING_MARGIN, FEED, CUT]);
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

module.exports = { printPhoto, isReady, ditherForPrint, dataUrlToRaster, ACTIVE_TONE };
