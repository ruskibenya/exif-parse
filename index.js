const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ExifTool } = require('exiftool-vendored');
const sharp = require('sharp');


const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const exiftool = new ExifTool();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Helper: Convert GPS from DMS to decimal if needed
function convertGPSCoordToDecimal(coordStr) {
  const regex = /(\d+)\D+(\d+)\D+([\d.]+)\D+([NSEW])/;
  const match = regex.exec(coordStr);
  if (!match) return null;

  let [, degrees, minutes, seconds, direction] = match;
  let decimal = parseInt(degrees) + parseInt(minutes) / 60 + parseFloat(seconds) / 3600;
  if (['S', 'W'].includes(direction)) decimal *= -1;
  return decimal;
}

app.post('/extract-metadata', upload.single('photo'), async (req, res) => {
  const tempInputPath = path.join(os.tmpdir(), `${Date.now()}_${req.file.originalname}`);
  const tempOutputPath = tempInputPath.replace(/\.\w+$/, '.jpg');

  try {
    // Save buffer to disk
    fs.writeFileSync(tempInputPath, req.file.buffer);

    // Extract metadata
    const tags = await exiftool.read(tempInputPath);
    let latitude = tags.GPSLatitude;
    let longitude = tags.GPSLongitude;

    if (typeof latitude === 'string') latitude = convertGPSCoordToDecimal(latitude);
    if (typeof longitude === 'string') longitude = convertGPSCoordToDecimal(longitude);

    const metadata = {
      hasLocationData: !!(latitude && longitude),
      latitude,
      longitude,
      dateTime: tags.DateTimeOriginal || tags.CreateDate || null,
      make: tags.Make || null,
      model: tags.Model || null
    };

    // Convert image to JPEG using sharp
    await sharp(tempInputPath)
      .rotate() // auto-orient if needed
      .jpeg({ quality: 90 })
      .toFile(tempOutputPath);

    // Read JPEG and convert to base64
    const jpegBuffer = fs.readFileSync(tempOutputPath);
    const base64Image = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;

    res.json({
      metadata,
      convertedImageData: base64Image,
      originalFormat: req.file.mimetype
    });

  } catch (error) {
    console.error("Error processing image:", error);
    res.status(500).json({ error: "Failed to extract metadata or convert image" });

  } finally {
    fs.unlink(tempInputPath, () => { });
    fs.unlink(tempOutputPath, () => { });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📸 Photo analyzer running on port ${PORT}`);
});
