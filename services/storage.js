const cloudinary = require('cloudinary').v2;
const QRCode = require('qrcode');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadAndGenerateQr(dataUrl, sessionId) {
  const uploadResult = await cloudinary.uploader.upload(dataUrl, {
    folder: 'photobooth',
    public_id: sessionId,
    resource_type: 'image'
  });
  const qrCode = await QRCode.toDataURL(uploadResult.secure_url, { margin: 1, width: 512 });
  return { photoUrl: uploadResult.secure_url, qrCode };
}

module.exports = { uploadAndGenerateQr };
