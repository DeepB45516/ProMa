const fs = require('fs');
const zlib = require('zlib');

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const toCrc = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([lenBuf, toCrc, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  let offset = 8;
  let ihdr = null;
  const idatChunks = [];

  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const w = ihdr.width;
  const h = ihdr.height;
  const bpp = 4;
  const img = Buffer.alloc(w * h * bpp);
  let rawOffset = 0;

  for (let y = 0; y < h; y++) {
    const filterType = raw[rawOffset++];
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * bpp;
      for (let c = 0; c < bpp; c++) {
        const xVal = raw[rawOffset++];
        const a = x > 0 ? img[idx - bpp + c] : 0;
        const b = y > 0 ? img[idx - w * bpp + c] : 0;
        const cVal = (x > 0 && y > 0) ? img[idx - w * bpp - bpp + c] : 0;
        let val = 0;
        if (filterType === 0) val = xVal;
        else if (filterType === 1) val = (xVal + a) & 0xff;
        else if (filterType === 2) val = (xVal + b) & 0xff;
        else if (filterType === 3) val = (xVal + Math.floor((a + b) / 2)) & 0xff;
        else if (filterType === 4) val = (xVal + paeth(a, b, cVal)) & 0xff;
        img[idx + c] = val;
      }
    }
  }
  return { width: w, height: h, data: img };
}

function encodePng(w, h, rgbaBuf) {
  const bpp = 4;
  const filteredData = Buffer.alloc(h * (w * bpp + 1));
  let fOffset = 0;
  for (let y = 0; y < h; y++) {
    filteredData[fOffset++] = 0; // Filter 0 (None)
    rgbaBuf.copy(filteredData, fOffset, y * w * bpp, (y + 1) * w * bpp);
    fOffset += w * bpp;
  }

  const compressedOut = zlib.deflateSync(filteredData, { level: 9 });

  const ihdrBuf = Buffer.alloc(13);
  ihdrBuf.writeUInt32BE(w, 0);
  ihdrBuf.writeUInt32BE(h, 4);
  ihdrBuf[8] = 8;
  ihdrBuf[9] = 6; // RGBA
  ihdrBuf[10] = 0;
  ihdrBuf[11] = 0;
  ihdrBuf[12] = 0;

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdrBuf);
  const idatChunk = makeChunk('IDAT', compressedOut);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
}

// Resample / scale with high-quality bilinear interpolation and 100% transparent padding
function createCenteredSquarePng(srcImg, targetSize) {
  const { width: sw, height: sh, data: sdata } = srcImg;

  // 1. Find tight bounding box of visible content
  let minX = sw, maxX = 0, minY = sh, maxY = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const a = sdata[(y * sw + x) * 4 + 3];
      if (a > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  console.log(`Bounding box: ${contentW}x${contentH} (from [${minX},${minY}] to [${maxX},${maxY}])`);

  // Target square with 4% padding for clean tab icon fit
  const pad = Math.round(targetSize * 0.04);
  const innerSize = targetSize - (pad * 2);
  const scale = Math.min(innerSize / contentW, innerSize / contentH);

  const drawW = Math.round(contentW * scale);
  const drawH = Math.round(contentH * scale);
  const startX = Math.round((targetSize - drawW) / 2);
  const startY = Math.round((targetSize - drawH) / 2);

  const outBuf = Buffer.alloc(targetSize * targetSize * 4, 0); // initialized to 0 (all transparent)

  // Bilinear resampling
  for (let dy = 0; dy < drawH; dy++) {
    const srcY = minY + (dy / scale);
    const sy0 = Math.floor(srcY);
    const sy1 = Math.min(sh - 1, sy0 + 1);
    const fy = srcY - sy0;

    for (let dx = 0; dx < drawW; dx++) {
      const srcX = minX + (dx / scale);
      const sx0 = Math.floor(srcX);
      const sx1 = Math.min(sw - 1, sx0 + 1);
      const fx = srcX - sx0;

      const idx00 = (sy0 * sw + sx0) * 4;
      const idx01 = (sy0 * sw + sx1) * 4;
      const idx10 = (sy1 * sw + sx0) * 4;
      const idx11 = (sy1 * sw + sx1) * 4;

      const outIdx = ((startY + dy) * targetSize + (startX + dx)) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = sdata[idx00 + c];
        const v01 = sdata[idx01 + c];
        const v10 = sdata[idx10 + c];
        const v11 = sdata[idx11 + c];

        const top = v00 * (1 - fx) + v01 * fx;
        const bot = v10 * (1 - fx) + v11 * fx;
        outBuf[outIdx + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }

  return encodePng(targetSize, targetSize, outBuf);
}

// Build standard multi-size Windows .ICO file with true alpha transparency
function buildIcoFile(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(count, 4); // Number of images

  let offset = 6 + (count * 16);
  const dirEntries = [];

  for (let i = 0; i < count; i++) {
    const png = pngBuffers[i].buffer;
    const size = pngBuffers[i].size;
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // Width
    entry[1] = size >= 256 ? 0 : size; // Height
    entry[2] = 0; // Color count
    entry[3] = 0; // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(png.length, 8); // Bytes in res
    entry.writeUInt32LE(offset, 12); // Offset
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([
    header,
    ...dirEntries,
    ...pngBuffers.map(p => p.buffer)
  ]);
}

const srcFile = 'C:/Users/Deep Biswas/.gemini/antigravity/brain/37f1d76a-cc68-4fd5-bebe-261f0f6ea23d/.user_uploaded/media_1787993854397.png';
console.log('Reading source image:', srcFile);
const srcBuf = fs.readFileSync(srcFile);
const decoded = decodePng(srcBuf);
console.log(`Source decoded: ${decoded.width}x${decoded.height}`);

// Generate 512x512, 192x192, 64x64, 32x32, 16x16 transparent PNGs
const png512 = createCenteredSquarePng(decoded, 512);
const png192 = createCenteredSquarePng(decoded, 192);
const png64 = createCenteredSquarePng(decoded, 64);
const png32 = createCenteredSquarePng(decoded, 32);
const png16 = createCenteredSquarePng(decoded, 16);

fs.writeFileSync('public/logo.png', png512);
fs.writeFileSync('public/favicon.png', png192);
fs.writeFileSync('public/apple-touch-icon.png', png192);
fs.writeFileSync('public/favicon-32x32.png', png32);
fs.writeFileSync('public/favicon-16x16.png', png16);

const icoBuf = buildIcoFile([
  { size: 16, buffer: png16 },
  { size: 32, buffer: png32 },
  { size: 64, buffer: png64 },
]);
fs.writeFileSync('public/favicon.ico', icoBuf);

console.log('✅ Generated 100% transparent square favicon.png, favicon.ico, and logo.png');
