const fs = require('fs');
const sharp = require('sharp');

const DEVICE_PATH = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
const PRINT_WIDTH_DOTS = 576; // 80mm paper, 203dpi thermal head, ~72mm printable width
const WIDTH_BYTES = PRINT_WIDTH_DOTS / 8;

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

async function dataUrlToRaster(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const inputBuffer = Buffer.from(base64, 'base64');
  const { data, info } = await sharp(inputBuffer)
    .flatten({ background: '#ffffff' })
    .resize({ width: PRINT_WIDTH_DOTS })
    .grayscale()
    .median(3)
    .clahe({ width: 32, height: 32, maxSlope: 1 })
    .gamma(1.6)
    .linear(1.0, 12)
    .sharpen({ sigma: 1.2, m1: 1.8, m2: 3.5 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const dithered = floydSteinbergDither(data, width, height);
  const packed = packBits(dithered, width, height);

  const header = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    WIDTH_BYTES & 0xff, (WIDTH_BYTES >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff
  ]);
  return Buffer.concat([header, packed]);
}

async function printPhoto(dataUrl, copies = 1) {
  const raster = await dataUrlToRaster(dataUrl);
  const receipt = Buffer.concat([ESC_INIT, raster, FEED, CUT]);
  const job = Buffer.concat(Array(copies).fill(receipt));
  fs.writeFileSync(DEVICE_PATH, job);
}

function isReady() {
  return fs.existsSync(DEVICE_PATH);
}

module.exports = { printPhoto, isReady };
