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
    .option('res', { type: 'string', demandOption: true })
    .option('volume', { type: 'number', demandOption: true })
    .help().argv;

if (![8, 9].includes(argv.bits)) {
    throw new Error('--bits must be 8 or 9');
}

const [WIDTH, HEIGHT] = argv.res.split(':').map(Number);
if (!WIDTH || !HEIGHT) throw new Error('Invalid --res');

const VOLUME = argv.volume / 100;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TILE_W = 8;
const TILE_H = 8;
const BYTES_PER_PIXEL = argv.bits === 8 ? 1 : 2;
const BYTES_PER_TILE = TILE_W * TILE_H * BYTES_PER_PIXEL;

const AUDIO_RATE = 11025;
const FPS = 30;

// -----------------------------------------------------------------------------
// Color encoding
// -----------------------------------------------------------------------------

function rgb332(r, g, b) {
    return (r >> 5) | ((g >> 5) << 3) | (b & 0b11000000);
}

function rgb333(r, g, b) {
    return ((b >> 5) << 6) | ((g >> 5) << 3) | (r >> 5);
}

// -----------------------------------------------------------------------------
// Tile extraction
// -----------------------------------------------------------------------------

function extractTiles(frame) {
    const tilesX = WIDTH / TILE_W;
    const tilesY = HEIGHT / TILE_H;
    const tiles = [];

    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const tile = Buffer.alloc(BYTES_PER_TILE);
            let o = 0;

            for (let y = 0; y < TILE_H; y++) {
                const row = (ty * TILE_H + y) * WIDTH + tx * TILE_W;
                for (let x = 0; x < TILE_W; x++) {
                    const v = frame[row + x];
                    if (argv.bits === 8) {
                        tile[o++] = v;
                    } else {
                        tile.writeUInt16LE(v, o);
                        o += 2;
                    }
                }
            }
            tiles.push(tile);
        }
    }
    return tiles;
}

// -----------------------------------------------------------------------------
// Output file
// -----------------------------------------------------------------------------

const out = fs.openSync(argv.output, 'w');

const HEADER_SIZE = 2 + 1 + 2 + 2 + 2 + 4 + 1 + 1 + 1 + 4 + 4 + 4 + 4;

fs.writeSync(out, Buffer.alloc(HEADER_SIZE));
console.log('[OUT] header reserved');

// -----------------------------------------------------------------------------
// VIDEO PHASE
// -----------------------------------------------------------------------------

console.log('[FFMPEG] start VIDEO');

const ffmpegVideo = spawn('ffmpeg', [
    '-i',
    argv.file,
    '-vf',
    `scale=${WIDTH}:${HEIGHT}:flags=bicubic,format=rgb24`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-vsync',
    '0',
    'pipe:1',
]);

const frameRGBSize = WIDTH * HEIGHT * 3;
const framePixels = WIDTH * HEIGHT;

let rgbBuf = Buffer.alloc(0);
let prevTiles = null;
let frameIndex = 0;
let videoSize = 0;

ffmpegVideo.stdout.on('data', (chunk) => {
    rgbBuf = Buffer.concat([rgbBuf, chunk]);

    while (rgbBuf.length >= frameRGBSize) {
        const rgb = rgbBuf.subarray(0, frameRGBSize);
        rgbBuf = rgbBuf.subarray(frameRGBSize);

        const frame = argv.bits === 8 ? Buffer.alloc(framePixels) : new Uint16Array(framePixels);

        for (let i = 0, j = 0; i < framePixels; i++) {
            const r = rgb[j++];
            const g = rgb[j++];
            const b = rgb[j++];
            frame[i] = argv.bits === 8 ? rgb332(r, g, b) : rgb333(r, g, b);
        }

        const tiles = extractTiles(frame);
        const updates = [];
        const keyframe = frameIndex === 0;

        if (keyframe || !prevTiles) {
            tiles.forEach((t, i) => updates.push({ index: i, data: t }));
        } else {
            for (let i = 0; i < tiles.length; i++) {
                if (!tiles[i].equals(prevTiles[i])) {
                    updates.push({ index: i, data: tiles[i] });
                }
            }
        }

        const fh = Buffer.alloc(3);
        fh.writeUInt8(keyframe ? 1 : 0, 0);
        fh.writeUInt16LE(updates.length, 1);
        fs.writeSync(out, fh);
        videoSize += 3;

        let prev = 0;
        for (const u of updates) {
            let skip = u.index - prev;
            while (skip >= 255) {
                fs.writeSync(out, Buffer.from([255]));
                videoSize++;
                skip -= 255;
            }
            fs.writeSync(out, Buffer.from([skip]));
            fs.writeSync(out, u.data);
            videoSize += 1 + u.data.length;
            prev = u.index + 1;
        }

        prevTiles = tiles;
        frameIndex++;

        if ((frameIndex & 16) === 0) {
            //console.log('[VIDEO] frame', frameIndex);
        }
    }
});

ffmpegVideo.on('close', () => {
    console.log('[VIDEO] done, frames =', frameIndex);

    // -------------------------------------------------------------------------
    // AUDIO PHASE (START ONLY NOW)
    // -------------------------------------------------------------------------

    console.log('[FFMPEG] start AUDIO');

    if ((videoSize & 1) !== 0) {
        console.log('[ALIGN] padding 1 byte before audio');
        fs.writeSync(out, Buffer.from([0]));
        videoSize += 1;
    }    

    const audioOffset = HEADER_SIZE + videoSize;
    let audioSamples = 0;

    const ffmpegAudio = spawn('ffmpeg', [
        '-i',
        argv.file,
        '-f',
        's16le',
        '-af',
        `volume=${VOLUME}`,
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        AUDIO_RATE.toString(),
        'pipe:1',
    ]);

    ffmpegAudio.stdout.on('data', (chunk) => {
        fs.writeSync(out, chunk, 0, chunk.length, audioOffset + audioSamples * 2);
        audioSamples += chunk.length / 2;
    });

    ffmpegAudio.on('close', () => {
        console.log('[AUDIO] done, samples =', audioSamples);

        finalize(audioOffset, audioSamples);
    });
});

// -----------------------------------------------------------------------------
// FINALIZE
// -----------------------------------------------------------------------------

function finalize(audioOffset, audioSamples) {
    console.log('[FINALIZE] write header');

    const header = Buffer.alloc(HEADER_SIZE);
    let o = 0;

    header.write('RV', o);
    o += 2;
    header.writeUInt8(4, o);
    o += 1;
    header.writeUInt16LE(WIDTH, o);
    o += 2;
    header.writeUInt16LE(HEIGHT, o);
    o += 2;
    header.writeUInt16LE(FPS, o);
    o += 2;
    header.writeUInt32LE(frameIndex, o);
    o += 4;
    header.writeUInt8(argv.bits, o);
    o += 1;
    header.writeUInt8(TILE_W, o);
    o += 1;
    header.writeUInt8(TILE_H, o);
    o += 1;
    header.writeUInt32LE(HEADER_SIZE, o);
    o += 4; // videoOffset
    header.writeUInt32LE(audioOffset, o);
    o += 4;
    header.writeUInt32LE(AUDIO_RATE, o);
    o += 4;
    header.writeUInt32LE(audioSamples, o);
    o += 4;

    fs.writeSync(out, header, 0, header.length, 0);
    fs.closeSync(out);

    console.log('[DONE] ✔', argv.output);
}
