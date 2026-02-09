#!/usr/bin/env node

const fs = require('fs');
const { spawn } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const argv = yargs(hideBin(process.argv))
    .option('file', { type: 'string', demandOption: true })
    .option('output', { type: 'string', demandOption: true })
    .option('bits', { type: 'number', demandOption: true })
    .help().argv;

const INPUT = argv.file;
const OUTPUT = argv.output;
const BITS = argv.bits;

if (BITS !== 8) {
    throw new Error('RV v2 supports only --bits=8');
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TILE_W = 8;
const TILE_H = 8;
const BYTES_PER_TILE = TILE_W * TILE_H;

// -----------------------------------------------------------------------------
// ffprobe
// -----------------------------------------------------------------------------

function probeVideo(file) {
    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height,r_frame_rate,nb_frames',
            '-of',
            'json',
            file,
        ]);

        let out = '';
        ffprobe.stdout.on('data', (d) => (out += d));
        ffprobe.on('close', () => {
            const s = JSON.parse(out).streams[0];
            const [n, d] = s.r_frame_rate.split('/').map(Number);

            resolve({
                width: s.width,
                height: s.height,
                fps: Math.round(n / d),
                frames: Number(s.nb_frames),
            });
        });
    });
}

// -----------------------------------------------------------------------------
// RGB888 → RGB332 (ESP32 native)
// -----------------------------------------------------------------------------

function rgb332(r, g, b) {
    return (r >> 5) | ((g >> 5) << 3) | (b & 0b11000000);
}

// -----------------------------------------------------------------------------
// Tile extraction
// -----------------------------------------------------------------------------

function extractTiles(frame332, width, height) {
    const tilesX = width / TILE_W;
    const tilesY = height / TILE_H;
    const tiles = [];

    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const tile = Buffer.alloc(BYTES_PER_TILE);
            let i = 0;

            for (let y = 0; y < TILE_H; y++) {
                const row = (ty * TILE_H + y) * width + tx * TILE_W;
                for (let x = 0; x < TILE_W; x++) {
                    tile[i++] = frame332[row + x];
                }
            }
            tiles.push(tile);
        }
    }
    return tiles;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

(async () => {
    const { width, height, fps, frames } = await probeVideo(INPUT);

    if (width % TILE_W || height % TILE_H) {
        throw new Error('Width/height must be divisible by 8');
    }

    const frameRGBSize = width * height * 3;
    const frame332Size = width * height;
    const tilesPerFrame = (width / 8) * (height / 8);

    console.log(`RV v2`);
    console.log(`${width}x${height} @ ${fps} fps`);
    console.log(`Tiles: ${tilesPerFrame}`);

    const out = fs.openSync(OUTPUT, 'w');

    // -------------------------------------------------------------------------
    // Header
    // -------------------------------------------------------------------------

    const header = Buffer.alloc(16);
    let o = 0;

    header.write('RV', o);
    o += 2;
    header.writeUInt8(2, o);
    o += 1;
    header.writeUInt16LE(width, o);
    o += 2;
    header.writeUInt16LE(height, o);
    o += 2;
    header.writeUInt16LE(fps, o);
    o += 2;
    header.writeUInt32LE(frames, o);
    o += 4;
    header.writeUInt8(8, o);
    o += 1;
    header.writeUInt8(TILE_W, o);
    o += 1;
    header.writeUInt8(TILE_H, o);
    o += 1;

    fs.writeSync(out, header);

    // -------------------------------------------------------------------------
    // ffmpeg
    // -------------------------------------------------------------------------

    const ffmpeg = spawn('ffmpeg', [
        '-i',
        INPUT,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-vsync',
        '0',
        'pipe:1',
    ]);

    let rgbBuf = Buffer.alloc(0);
    let prevTiles = null;
    let frameIndex = 0;

    ffmpeg.stdout.on('data', (chunk) => {
        rgbBuf = Buffer.concat([rgbBuf, chunk]);

        while (rgbBuf.length >= frameRGBSize) {
            const rgb = rgbBuf.subarray(0, frameRGBSize);
            rgbBuf = rgbBuf.subarray(frameRGBSize);

            // -------------------------------------------------------------
            // Quantize to RGB332
            // -------------------------------------------------------------
            const frame332 = Buffer.alloc(frame332Size);
            for (let i = 0, j = 0; i < frame332Size; i++) {
                frame332[i] = rgb332(rgb[j++], rgb[j++], rgb[j++]);
            }

            const tiles = extractTiles(frame332, width, height);

            const isKeyframe = frameIndex === 0;
            const updates = [];

            if (isKeyframe || !prevTiles) {
                for (let i = 0; i < tiles.length; i++) {
                    updates.push({ index: i, data: tiles[i] });
                }
            } else {
                for (let i = 0; i < tiles.length; i++) {
                    if (!tiles[i].equals(prevTiles[i])) {
                        updates.push({ index: i, data: tiles[i] });
                    }
                }
            }

            // -------------------------------------------------------------
            // FrameHeader
            // -------------------------------------------------------------
            const fh = Buffer.alloc(3);
            fh.writeUInt8(isKeyframe ? 1 : 0, 0);
            fh.writeUInt16LE(updates.length, 1);
            fs.writeSync(out, fh);

            // -------------------------------------------------------------
            // Tile updates (skip RLE)
            // -------------------------------------------------------------
            let prevIndex = 0;

            for (const u of updates) {
                let skip = u.index - prevIndex;

                while (skip >= 255) {
                    fs.writeSync(out, Buffer.from([255]));
                    skip -= 255;
                }

                fs.writeSync(out, Buffer.from([skip]));
                fs.writeSync(out, u.data);

                prevIndex = u.index + 1;
            }

            prevTiles = tiles;
            frameIndex++;

            if ((frameIndex & 7) === 0) {
                process.stdout.write(`\rFrame ${frameIndex}/${frames}`);
            }
        }
    });

    ffmpeg.on('close', () => {
        fs.closeSync(out);
        console.log(`\nDONE ✔ ${OUTPUT}`);
    });
})();
