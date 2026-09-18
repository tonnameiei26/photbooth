const cloudinary = require('cloudinary').v2;
const QRCode = require('qrcode');
const sharp = require('sharp');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Plain grayscale filter for the downloadable black & white photo -- kept at
// full resolution and undithered so it looks clean on a phone screen. The
// heavy Floyd-Steinberg dithering in printer.js is tuned for the 203dpi
// thermal head and looks noisy/broken when viewed digitally, so it is not
// reused here.
async function toBlackAndWhite(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  const pngBuffer = await sharp(buffer).flatten({ background: '#ffffff' }).grayscale().png().toBuffer();
  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}

async function uploadAndGenerateQr(colorDataUrl, sessionId) {
  const bwDataUrl = await toBlackAndWhite(colorDataUrl);
  const [colorUpload, bwUpload] = await Promise.all([
    cloudinary.uploader.upload(colorDataUrl, { folder: 'photobooth', public_id: sessionId, resource_type: 'image' }),
    cloudinary.uploader.upload(bwDataUrl, { folder: 'photobooth', public_id: `${sessionId}-bw`, resource_type: 'image' })
  ]);
  const [qrCode, qrCodeBw] = await Promise.all([
    QRCode.toDataURL(colorUpload.secure_url, { margin: 1, width: 512 }),
    QRCode.toDataURL(bwUpload.secure_url, { margin: 1, width: 512 })
  ]);
  return { photoUrl: colorUpload.secure_url, qrCode, photoUrlBw: bwUpload.secure_url, qrCodeBw };
}

module.exports = { uploadAndGenerateQr };
