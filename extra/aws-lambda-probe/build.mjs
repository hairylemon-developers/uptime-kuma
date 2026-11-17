/**
 * Build function.zip for the Uptime Kuma AWS Lambda probe.
 * Usage: node extra/aws-lambda-probe/build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "index.js");
const outPath = path.join(__dirname, "function.zip");

const fileName = "index.js";
const content = fs.readFileSync(sourcePath);
const crc = crc32(content);
const compressed = deflateRawSync(content);

const localHeader = Buffer.alloc(30 + fileName.length);
localHeader.writeUInt32LE(0x04034b50, 0);
localHeader.writeUInt16LE(20, 4); // version needed
localHeader.writeUInt16LE(0, 6); // flags
localHeader.writeUInt16LE(8, 8); // deflate
localHeader.writeUInt16LE(0, 10); // time
localHeader.writeUInt16LE(0, 12); // date
localHeader.writeUInt32LE(crc, 14);
localHeader.writeUInt32LE(compressed.length, 18);
localHeader.writeUInt32LE(content.length, 22);
localHeader.writeUInt16LE(fileName.length, 26);
localHeader.writeUInt16LE(0, 28); // extra length
localHeader.write(fileName, 30);

const centralHeader = Buffer.alloc(46 + fileName.length);
centralHeader.writeUInt32LE(0x02014b50, 0);
centralHeader.writeUInt16LE(20, 4); // version made by
centralHeader.writeUInt16LE(20, 6); // version needed
centralHeader.writeUInt16LE(0, 8);
centralHeader.writeUInt16LE(8, 10);
centralHeader.writeUInt16LE(0, 12);
centralHeader.writeUInt16LE(0, 14);
centralHeader.writeUInt32LE(crc, 16);
centralHeader.writeUInt32LE(compressed.length, 20);
centralHeader.writeUInt32LE(content.length, 24);
centralHeader.writeUInt16LE(fileName.length, 28);
centralHeader.writeUInt16LE(0, 30);
centralHeader.writeUInt16LE(0, 32);
centralHeader.writeUInt16LE(0, 34);
centralHeader.writeUInt16LE(0, 36);
centralHeader.writeUInt32LE(0, 38);
centralHeader.writeUInt32LE(0, 42); // relative offset of local header
centralHeader.write(fileName, 46);

const endRecord = Buffer.alloc(22);
endRecord.writeUInt32LE(0x06054b50, 0);
endRecord.writeUInt16LE(0, 4);
endRecord.writeUInt16LE(0, 6);
endRecord.writeUInt16LE(1, 8);
endRecord.writeUInt16LE(1, 10);
endRecord.writeUInt32LE(centralHeader.length, 12);
endRecord.writeUInt32LE(localHeader.length + compressed.length, 16);
endRecord.writeUInt16LE(0, 20);

const zip = Buffer.concat([localHeader, compressed, centralHeader, endRecord]);
fs.writeFileSync(outPath, zip);

const hash = createHash("sha256").update(zip).digest("hex");
console.log(`Wrote ${outPath} (${zip.length} bytes, sha256=${hash})`);

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}
