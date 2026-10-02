const cloudinary = require('cloudinary').v2;
const QRCode = require('qrcode');
const sharp = require('sharp');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// The downloadable photos are stored as high-quality JPEG rather than PNG.
// Upload time over the booth's internet link is what decides how long guests
// wait for their QR codes, and a JPEG at this quality is about a quarter of
// the size of the PNG with no visible difference on a phone.
const JPEG_QUALITY = 92;

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

// Sends the image bytes as-is. (Passing Cloudinary a data: URL instead would
// base64-encode them, which makes the upload a third bigger.)
function uploadImage(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'photobooth', public_id: publicId, resource_type: 'image' },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function uploadAndGenerateQr(colorDataUrl, sessionId) {
  const original = sharp(dataUrlToBuffer(colorDataUrl)).flatten({ background: '#ffffff' });
  // Plain grayscale filter for the downloadable black & white photo -- kept at
  // full resolution and undithered so it looks clean on a phone screen. The
  // heavy Floyd-Steinberg dithering in printer.js is tuned for the 203dpi
  // thermal head and looks noisy/broken when viewed digitally, so it is not
  // reused here.
  const [colorJpeg, bwJpeg] = await Promise.all([
    // 4:4:4 keeps full colour detail so the frame's red lettering stays crisp.
    original.clone().jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' }).toBuffer(),
    original.clone().grayscale().jpeg({ quality: JPEG_QUALITY }).toBuffer()
  ]);
  const [colorUpload, bwUpload] = await Promise.all([
    uploadImage(colorJpeg, sessionId),
    uploadImage(bwJpeg, `${sessionId}-bw`)
  ]);
  const [qrCode, qrCodeBw] = await Promise.all([
    QRCode.toDataURL(colorUpload.secure_url, { margin: 1, width: 512 }),
    QRCode.toDataURL(bwUpload.secure_url, { margin: 1, width: 512 })
  ]);
  return { photoUrl: colorUpload.secure_url, qrCode, photoUrlBw: bwUpload.secure_url, qrCodeBw };
}

module.exports = { uploadAndGenerateQr };
