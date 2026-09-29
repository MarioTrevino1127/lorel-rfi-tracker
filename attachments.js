const multer = require('multer');
const { Jimp, JimpMime } = require('jimp');
const { PDFDocument } = require('pdf-lib');

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new Error('Only PDF, JPG, and PNG files are allowed.'));
  }
  cb(null, true);
}

// Memory storage — files never touch local disk, which this hosting platform doesn't
// persist anyway. The buffer is stripped of metadata, then stored as a BLOB in MySQL.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

// Strips identifying metadata from an uploaded file's buffer.
// Images: re-encoded through sharp, which drops EXIF/GPS/device data by default.
// PDFs: clears the standard Info dictionary fields (author, title, producer, etc).
// This is a best-effort pass — some PDF editors embed metadata in ways this won't
// catch (e.g. custom XMP streams), so it's not an absolute guarantee for PDFs.
// Returns the cleaned buffer, or the original buffer if stripping fails for any reason.
async function stripMetadata(buffer, mimeType) {
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
      const image = await Jimp.read(buffer);
      const outMime = mimeType === 'image/jpeg' ? JimpMime.jpeg : JimpMime.png;
      return await image.getBuffer(outMime);
    }
    if (mimeType === 'application/pdf') {
      const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false });
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('');
      pdfDoc.setCreator('');
      const cleaned = await pdfDoc.save();
      return Buffer.from(cleaned);
    }
    return buffer;
  } catch (err) {
    console.error(`[attachments] Metadata stripping failed, keeping original file:`, err.message);
    return buffer;
  }
}

module.exports = { upload, stripMetadata, MAX_FILE_SIZE };
