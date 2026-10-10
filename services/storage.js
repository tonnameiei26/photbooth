const https = require('https');
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

// The booth's internet link (a phone hotspot for now) drops out briefly from
// time to time, so an upload that fails is tried again before giving up.
// Keep the worst case (every attempt timing out) shorter than QR_WAIT_MS in app.js.
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 2000;
const UPLOAD_TIMEOUT_MS = 20000;
// The behind-the-scenes clip is a few times bigger than the photos, so it gets longer.
const CLIP_UPLOAD_TIMEOUT_MS = 45000;

// Uploads look up Cloudinary's address as IPv4 only. Asking for an IPv6 address
// as well (the default) makes every upload wait about 15 seconds on the booth's
// TP-Link router, which never answers that question for Cloudinary's upload
// server, and guests would wait that much longer for their QR codes.
const uploadAgent = new https.Agent({ family: 4 });

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

// Sends the file's bytes as-is. (Passing Cloudinary a data: URL instead would
// base64-encode them, which makes the upload a third bigger.)
function uploadOnce(buffer, publicId, resourceType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'photobooth', public_id: publicId, resource_type: resourceType, timeout: timeoutMs, agent: uploadAgent },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function uploadImage(buffer, publicId, resourceType = 'image', timeoutMs = UPLOAD_TIMEOUT_MS) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await uploadOnce(buffer, publicId, resourceType, timeoutMs);
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS) throw error;
      console.warn(`Upload of ${publicId} failed (attempt ${attempt} of ${UPLOAD_ATTEMPTS}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
    }
  }
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

// The clip is stored exactly as the iPad recorded it and the QR code points at
// that original file: asking Cloudinary to convert or resize video costs far
// more of the plan's credits than storing it does.
async function uploadClipAndGenerateQr(clipBuffer, sessionId) {
  const upload = await uploadImage(clipBuffer, `${sessionId}-clip`, 'video', CLIP_UPLOAD_TIMEOUT_MS);
  // A phone that opens a video link just plays it, with no way to keep it
  // (unlike a photo, which can be long-pressed and saved). The "attachment"
  // flag makes the same file arrive as a download instead.
  const downloadUrl = cloudinary.url(upload.public_id, { resource_type: 'video', secure: true, version: upload.version, format: upload.format, flags: 'attachment:snaplicious-video' });
  const qrCodeClip = await QRCode.toDataURL(downloadUrl, { margin: 1, width: 512 });
  return { clipUrl: downloadUrl, qrCodeClip };
}

module.exports = { uploadAndGenerateQr, uploadClipAndGenerateQr };
