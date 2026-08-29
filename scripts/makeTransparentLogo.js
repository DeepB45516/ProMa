const fs = require('fs');
const zlib = require('zlib');

// CRC32 table
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

function processLogo(inputPath, outputPath) {
  const buf = fs.readFileSync(inputPath);
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

  // Unfilter PNG scanlines
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

  console.log(`Image decoded: ${w}x${h}`);

  // BFS / Flood fill from outer corners to convert white background to transparent alpha
  const visited = new Uint8Array(w * h);
  const queueX = new Int32Array(w * h);
  const queueY = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  function push(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const pos = y * w + x;
    if (visited[pos]) return;
    const idx = pos * bpp;
    const r = img[idx];
    const g = img[idx + 1];
    const b = img[idx + 2];
    // If pixel is near white/light gray background (R > 235, G > 235, B > 235)
    if (r > 230 && g > 230 && b > 230) {
      visited[pos] = 1;
      queueX[tail] = x;
      queueY[tail] = y;
      tail++;
    }
  }

  // Seed all borders
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  while (head < tail) {
    const cx = queueX[head];
    const cy = queueY[head];
    head++;

    push(cx + 1, cy);
    push(cx - 1, cy);
    push(cx, cy + 1);
    push(cx, cy - 1);
  }

  // Apply transparency to visited outer white background
  let transparentCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pos = y * w + x;
      const idx = pos * bpp;
      if (visited[pos]) {
        img[idx + 3] = 0; // Set Alpha = 0 (Transparent)
        transparentCount++;
      }
    }
  }

  console.log(`Converted ${transparentCount} outer white pixels to transparent alpha`);

  // Re-encode scanlines with Filter Type 0 (None)
  const filteredData = Buffer.alloc(h * (w * bpp + 1));
  let fOffset = 0;
  for (let y = 0; y < h; y++) {
    filteredData[fOffset++] = 0; // Filter 0
    img.copy(filteredData, fOffset, y * w * bpp, (y + 1) * w * bpp);
    fOffset += w * bpp;
  }

  const compressedOut = zlib.deflateSync(filteredData, { level: 9 });

  const ihdrBuf = Buffer.alloc(13);
  ihdrBuf.writeUInt32BE(w, 0);
  ihdrBuf.writeUInt32BE(h, 4);
  ihdrBuf[8] = 8; // bitDepth
  ihdrBuf[9] = 6; // RGBA
  ihdrBuf[10] = 0;
  ihdrBuf[11] = 0;
  ihdrBuf[12] = 0;

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdrBuf);
  const idatChunk = makeChunk('IDAT', compressedOut);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const outPng = Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
  fs.writeFileSync(outputPath, outPng);
  console.log(`Saved transparent PNG: ${outputPath} (${outPng.length} bytes)`);
}

processLogo('public/logo.png', 'public/logo.png');
fs.copyFileSync('public/logo.png', 'public/favicon.png');
fs.copyFileSync('public/logo.png', 'public/favicon.ico');
console.log('Successfully updated logo.png, favicon.png, and favicon.ico with true transparency!');
