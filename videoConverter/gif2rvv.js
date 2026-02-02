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
    .usage(
        'node gif2rvv.js <input.gif> -o out.rvv ' + '--bpp <1|2|4|8> --fps <fps> --kf <interval>'
    )
    .demandCommand(1)
    .option('o', { alias: 'output', demandOption: true })
    .option('bpp', { type: 'number', demandOption: true })
    .option('fps', { type: 'number', demandOption: true })
    .option('kf', {
        type: 'number',
        default: 0,
        describe: 'Keyframe interval (0 = only first)',
    })
    .help().argv;

const INPUT = argv._[0];
const OUTPUT = argv.output;
const BPP = argv.bpp;
const FPS = argv.fps;
const KEYFRAME_INTERVAL = argv.kf | 0;

if (![1, 2, 4, 8].includes(BPP)) {
    throw new Error('Invalid bpp');
}

// -----------------------------------------------------------------------------
// Load GIF
// -----------------------------------------------------------------------------

const gif = parseGIF(fs.readFileSync(INPUT));
const frames = decompressFrames(gif, false);

const WIDTH = gif.lsd.width;
const HEIGHT = gif.lsd.height;

if (WIDTH % TILE || HEIGHT % TILE) {
    throw new Error('Width/height must be divisible by 8');
}

const gct = gif.gct;
const PALETTE_SIZE = 1 << BPP;

if (!gct || gct.length < PALETTE_SIZE) {
    throw new Error('Palette too small');
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const TILES_X = WIDTH / TILE;
const TILES_Y = HEIGHT / TILE;
const TILE_COUNT = TILES_X * TILES_Y;
const BYTES_PER_TILE = (TILE * TILE * BPP) >> 3;

console.log(`GIF ${WIDTH}x${HEIGHT}, frames=${frames.length}`);
console.log(`RVV v5 | ${BPP}bpp | ${FPS}fps | KF=${KEYFRAME_INTERVAL || 'first only'}`);

// -----------------------------------------------------------------------------
// Write header (RVV v5)
// -----------------------------------------------------------------------------

const out = fs.openSync(OUTPUT, 'w');

/*
RVV v5 HEADER
--------------------------------
char[3]  "RVV"
uint8    version = 5
uint16   width
uint16   height
uint8    tile_w
uint8    tile_h
uint8    bpp
uint8    fps
uint16   frame_count
uint16   palette_size
uint16   keyframe_interval
*/

const header = Buffer.alloc(18);
let ho = 0;

header.write('RVV', ho);
ho += 3;
header.writeUInt8(5, ho);
ho += 1;
header.writeUInt16LE(WIDTH, ho);
ho += 2;
header.writeUInt16LE(HEIGHT, ho);
ho += 2;
header.writeUInt8(TILE, ho);
ho += 1;
header.writeUInt8(TILE, ho);
ho += 1;
header.writeUInt8(BPP, ho);
ho += 1;
header.writeUInt8(FPS, ho);
ho += 1;
header.writeUInt16LE(frames.length, ho);
ho += 2;
header.writeUInt16LE(PALETTE_SIZE, ho);
ho += 2;
header.writeUInt16LE(KEYFRAME_INTERVAL, ho);
ho += 2;

fs.writeSync(out, header);

// -----------------------------------------------------------------------------
// Palette (RGB888)
// -----------------------------------------------------------------------------

for (let i = 0; i < PALETTE_SIZE; i++) {
    const [r, g, b] = gct[i];
    fs.writeSync(out, Buffer.from([r, g, b]));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function packTile(pixels) {
    const buf = Buffer.alloc(BYTES_PER_TILE);
    let bit = 0;
    let byte = 0;

    for (let p of pixels) {
        for (let b = BPP - 1; b >= 0; b--) {
            buf[byte] |= ((p >> b) & 1) << (7 - bit);
            bit++;
            if (bit === 8) {
                bit = 0;
                byte++;
            }
        }
    }
    return buf;
}

function extractTiles(fb) {
    const tiles = new Array(TILE_COUNT);
    let ti = 0;

    for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
            const pixels = [];
            for (let y = 0; y < TILE; y++) {
                for (let x = 0; x < TILE; x++) {
                    pixels.push(fb[(ty * TILE + y) * WIDTH + (tx * TILE + x)]);
                }
            }
            tiles[ti++] = packTile(pixels);
        }
    }
    return tiles;
}

// -----------------------------------------------------------------------------
// GIF framebuffer
// -----------------------------------------------------------------------------

const gifFB = new Uint8Array(WIDTH * HEIGHT);
gifFB.fill(0);

let prevTiles = null;
let prevFrame = null;

function applyDisposal(frame) {
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
            const i = y * width + x;
            const pix = src[i];
            if (transparent !== undefined && pix === transparent) continue;
            gifFB[(top + y) * WIDTH + (left + x)] = pix;
        }
    }
}

// -----------------------------------------------------------------------------
// Main loop + Skip-index RLE
// -----------------------------------------------------------------------------

frames.forEach((frame, frameIndex) => {
    if (prevFrame) applyDisposal(prevFrame);
    blitFrame(frame);

    const tiles = extractTiles(gifFB);

    const isKeyframe =
        frameIndex === 0 || (KEYFRAME_INTERVAL > 0 && frameIndex % KEYFRAME_INTERVAL === 0);

    const updates = [];

    if (isKeyframe || !prevTiles) {
        for (let i = 0; i < TILE_COUNT; i++) {
            updates.push({ index: i, data: tiles[i] });
        }
    } else {
        for (let i = 0; i < TILE_COUNT; i++) {
            if (!tiles[i].equals(prevTiles[i])) {
                updates.push({ index: i, data: tiles[i] });
            }
        }
    }

    /*
    FrameHeader v5
    ----------------
    uint8   flags   (bit0 = keyframe)
    uint16  update_count
    */

    const fh = Buffer.alloc(3);
    fh.writeUInt8(isKeyframe ? 1 : 0, 0);
    fh.writeUInt16LE(updates.length, 1);
    fs.writeSync(out, fh);

    /*
    TileUpdate v5
    ----------------
    uint8   skip
    bytes   tile_data   (ONLY if skip < 255)
    */

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
    prevFrame = frame;

    if (frameIndex % 50 === 0) {
        console.log(
            `frame ${frameIndex}/${frames.length} | ` +
                (isKeyframe ? 'KEY' : 'diff') +
                ` | updates=${updates.length}`
        );
    }
});

fs.closeSync(out);
console.log('DONE:', OUTPUT);
