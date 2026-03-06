const fs = require('fs');
const zlib = require('zlib');

const width = 128;
const height = 128;
const bg = [0x0f, 0x17, 0x2a]; // #0f172a
const fg = [0x10, 0xb9, 0x81]; // #10b981

function crc32(buf) {
  const table = crc32.table || (crc32.table = makeTable());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}
function makeTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data ? data.length : 0, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data || Buffer.alloc(0)]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data || Buffer.alloc(0), crcBuf]);
}

// PNG signature
const sig = Buffer.from([137,80,78,71,13,10,26,10]);

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// build raw image data (filter byte + pixels per row)
const rowBytes = 1 + 3 * width;
const raw = Buffer.alloc(rowBytes * height);

// E shape parameters
const x0 = 26;
const widthE = 76;
const thick = 18;
const y0 = 16;
const heightE = 96;

for (let y = 0; y < height; y++) {
  const rowStart = y * rowBytes;
  raw[rowStart] = 0; // no filter
  for (let x = 0; x < width; x++) {
    const pxIndex = rowStart + 1 + x * 3;
    let useFg = false;
    // vertical bar
    if (x >= x0 && x < x0 + thick && y >= y0 && y < y0 + heightE) useFg = true;
    // top bar
    if (x >= x0 && x < x0 + widthE && y >= y0 && y < y0 + thick) useFg = true;
    // middle bar
    const midY = y0 + Math.floor(heightE / 2) - Math.floor(thick / 2);
    if (x >= x0 && x < x0 + widthE && y >= midY && y < midY + thick) useFg = true;
    // bottom bar
    if (x >= x0 && x < x0 + widthE && y >= y0 + heightE - thick && y < y0 + heightE) useFg = true;

    const col = useFg ? fg : bg;
    raw[pxIndex] = col[0];
    raw[pxIndex + 1] = col[1];
    raw[pxIndex + 2] = col[2];
  }
}

const compressed = zlib.deflateSync(raw);

const idat = chunk('IDAT', compressed);
const ihdrChunk = chunk('IHDR', ihdr);
const iend = chunk('IEND', Buffer.alloc(0));

const out = Buffer.concat([sig, ihdrChunk, idat, iend]);
fs.writeFileSync('images/icon.png', out);
console.log('images/icon.png written', out.length, 'bytes');
