#!/usr/bin/env node

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { parseGIF, decompressFrames } = require('gifuct-js');

const TILE = 8;

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const argv = yargs(hideBin(process.argv))
    .usage('node gif2rvv.js <input.gif> -o out.rvv --bpp <1|2|4|8> --fps <fps>')
    .demandCommand(1)
    .option('o', {
        alias: 'output',
        type: 'string',
        demandOption: true,
        describe: 'Output RVV file',
    })
    .option('bpp', {
        type: 'number',
        demandOption: true,
        describe: 'Bits per pixel (1,2,4,8)',
    })
    .option('fps', {
        type: 'number',
        demandOption: true,
        describe: 'Frames per second',
    })
    .help().argv;

const INPUT = argv._[0];
const OUTPUT = argv.output;
const BPP = argv.bpp;
const FPS = argv.fps;

if (![1, 2, 4, 8].includes(BPP)) {
    throw new Error('bpp must be 1, 2, 4 or 8');
}

// -----------------------------------------------------------------------------
// Load GIF
// -----------------------------------------------------------------------------

const gif = parseGIF(fs.readFileSync(INPUT));
const frames = decompressFrames(gif, false);

const WIDTH = gif.lsd.width;
const HEIGHT = gif.lsd.height;

if (WIDTH % TILE || HEIGHT % TILE) {
    throw new Error('GIF width/height must be divisible by 8');
}

const gct = gif.gct;
if (!gct) {
    throw new Error('GIF has no global color table');
}

const PALETTE_SIZE = 1 << BPP;
if (gct.length < PALETTE_SIZE) {
    throw new Error(`GIF palette too small for ${BPP} bpp`);
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const TILES_X = WIDTH / TILE;
const TILES_Y = HEIGHT / TILE;
const TILE_COUNT = TILES_X * TILES_Y;
const BYTES_PER_TILE = (TILE * TILE * BPP) >> 3;

console.log(`GIF: ${WIDTH}x${HEIGHT}, frames=${frames.length}`);
console.log(`RVV2: ${BPP}bpp, ${FPS}fps`);
console.log(`Palette used: ${PALETTE_SIZE} colors (from ${gct.length})`);

// -----------------------------------------------------------------------------
// Open output + write header (RVV2)
// -----------------------------------------------------------------------------

const out = fs.openSync(OUTPUT, 'w');

// --- Header (RVV2) ---
const header = Buffer.alloc(16);
header.write('RVV2', 0); // magic
header.writeUInt16LE(WIDTH, 4);
header.writeUInt16LE(HEIGHT, 6);
header.writeUInt8(8, 8); // tile_w
header.writeUInt8(8, 9); // tile_h
header.writeUInt8(BPP, 10);
header.writeUInt8(FPS, 11);
header.writeUInt16LE(frames.length, 12); // frame_count
header.writeUInt16LE(PALETTE_SIZE, 14); // palette_size
fs.writeSync(out, header);

// --- Palette (RGB888) ---
for (let i = 0; i < PALETTE_SIZE; i++) {
    const [r, g, b] = gct[i];
    fs.writeSync(out, Buffer.from([r, g, b]));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function packTile(pixels) {
    const out = Buffer.alloc(BYTES_PER_TILE);
    let bit = 0;
    let byte = 0;

    for (let p of pixels) {
        for (let b = BPP - 1; b >= 0; b--) {
            out[byte] |= ((p >> b) & 1) << (7 - bit);
            bit++;
            if (bit === 8) {
                bit = 0;
                byte++;
            }
        }
    }
    return out;
}

function extractTiles(framebuffer) {
    const tiles = new Array(TILE_COUNT);
    let ti = 0;

    for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
            const pixels = [];
            for (let y = 0; y < TILE; y++) {
                for (let x = 0; x < TILE; x++) {
                    const px = (ty * TILE + y) * WIDTH + (tx * TILE + x);
                    pixels.push(framebuffer[px]);
                }
            }
            tiles[ti++] = packTile(pixels);
        }
    }
    return tiles;
}

// -----------------------------------------------------------------------------
// GIF framebuffer compositing
// -----------------------------------------------------------------------------

const gifFB = new Uint8Array(WIDTH * HEIGHT);
gifFB.fill(0); // индекс 0 = фон (как в GIF)

let prevTiles = null;
let prevFrame = null;

function applyDisposal(frame) {
    // 0 / 1 - do nothing
    // 2     - restore to background
    if (frame.disposalType === 2) {
        gifFB.fill(0);
    }
}

function blitFrame(frame) {
    const { left, top, width, height } = frame.dims;
    const src = frame.pixels;
    const transparent = frame.transparentIndex;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const srcIdx = y * width + x;
            const pix = src[srcIdx];

            if (transparent !== undefined && pix === transparent) {
                continue;
            }

            const dst = (top + y) * WIDTH + (left + x);

            gifFB[dst] = pix;
        }
    }
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

frames.forEach((frame, frameIndex) => {
    if (prevFrame) {
        applyDisposal(prevFrame);
    }

    blitFrame(frame);

    const tiles = extractTiles(gifFB);
    const diffs = [];

    if (!prevTiles) {
        // Keyframe
        for (let i = 0; i < TILE_COUNT; i++) {
            diffs.push({ index: i, data: tiles[i] });
        }
    } else {
        for (let i = 0; i < TILE_COUNT; i++) {
            if (!tiles[i].equals(prevTiles[i])) {
                diffs.push({ index: i, data: tiles[i] });
            }
        }
    }

    // FrameHeader
    const fh = Buffer.alloc(2);
    fh.writeUInt16LE(diffs.length);
    fs.writeSync(out, fh);

    // TileUpdates
    for (const d of diffs) {
        const rec = Buffer.alloc(2 + BYTES_PER_TILE);
        rec.writeUInt16LE(d.index, 0);
        d.data.copy(rec, 2);
        fs.writeSync(out, rec);
    }

    prevTiles = tiles;
    prevFrame = frame;

    if (frameIndex % 50 === 0) {
        console.log(`frame ${frameIndex}/${frames.length}, changed tiles=${diffs.length}`);
    }
});

fs.closeSync(out);
console.log('DONE:', OUTPUT);
