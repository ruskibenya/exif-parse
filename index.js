require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { ExifTool } = require('exiftool-vendored');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const exiftool = new ExifTool();

// Load and validate environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing Supabase environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Convert DMS GPS format to decimal
function convertGPSCoordToDecimal(coordStr) {
  const regex = /([\d.]+)\D+([\d.]+)\D+([\d.]+)\D+([NSEW])/;
  const match = regex.exec(coordStr);
  if (!match) return null;

  let [, degrees, minutes, seconds, direction] = match;
  let decimal = parseFloat(degrees) + parseFloat(minutes) / 60 + parseFloat(seconds) / 3600;
  if (['S', 'W'].includes(direction)) decimal *= -1;
  return decimal;
}

app.post('/extract-metadata', upload.single('photo'), async (req, res) => {
  const timestamp = Date.now();
  const originalName = req.file.originalname;
  const ext = path.extname(originalName);
  const baseName = originalName.slice(0, -ext.length);
  const heicPath = path.join(os.tmpdir(), `${timestamp}_${baseName}.HEIC`);
  const jpgPath = path.join(os.tmpdir(), `${timestamp}_${baseName}.jpg`);
  const uploadPath = `${timestamp}_${Math.random().toString(36).substring(2, 8)}_${baseName}.jpg`;

  try {
    // Save uploaded file temporarily
    fs.writeFileSync(heicPath, req.file.buffer);

    // Extract metadata
    const tags = await exiftool.read(heicPath);
    let latitude = tags.GPSLatitude;
    let longitude = tags.GPSLongitude;

    if (typeof latitude === 'string') latitude = convertGPSCoordToDecimal(latitude);
    if (typeof longitude === 'string') longitude = convertGPSCoordToDecimal(longitude);
    if (isNaN(latitude)) latitude = null;
    if (isNaN(longitude)) longitude = null;

    const metadata = {
      hasLocationData: !!(latitude && longitude),
      latitude,
      longitude,
      dateTime: tags.DateTimeOriginal || tags.CreateDate || null,
      make: tags.Make || null,
      model: tags.Model || null,
      originalFormat: req.file?.mimetype || 'image/heic'
    };

    // Convert HEIC to JPEG using ImageMagick
    await new Promise((resolve, reject) => {
      exec(`convert "${heicPath}" "${jpgPath}"`, (err, stdout, stderr) => {
        if (err) {
          console.error("ImageMagick conversion error:", stderr || err.message);
          return reject(err);
        }
        resolve();
      });
    });

    // Upload converted image to Supabase Storage
    const fileData = fs.readFileSync(jpgPath);
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(uploadPath, fileData, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload image to Supabase' });
    }

    const { data: publicUrlData, error: publicUrlError } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(uploadPath);

    if (publicUrlError || !publicUrlData?.publicUrl) {
      console.error('❌ Failed to generate public URL:', publicUrlError);
      return res.status(500).json({ error: 'Failed to retrieve image URL from Supabase' });
    }
    
    metadata.image_url = { url: publicUrlData.publicUrl };

    res.json(metadata);
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ error: 'Failed to process image' });
  } finally {
    try { await fs.promises.unlink(heicPath); } catch {}
    try { await fs.promises.unlink(jpgPath); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📸 Metadata + Image upload service running on port ${PORT}`);
});