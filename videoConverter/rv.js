#!/usr/bin/env node

const fs = require('fs');
const { spawn } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

const argv = yargs(hideBin(process.argv))
    .option('file', {
        type: 'string',
        demandOption: true,
        describe: 'Input video file (mp4, mkv, etc)',
    })
    .option('output', {
        type: 'string',
        demandOption: true,
        describe: 'Output .rv file',
    })
    .option('bits', {
        type: 'number',
        demandOption: true,
        describe: 'Bits per pixel (only 8 supported)',
    })
    .help()
    .argv;

const INPUT = argv.file;
const OUTPUT = argv.output;
const BITS = argv.bits;

if (BITS !== 8) {
    throw new Error('RV v1 currently supports only --bits=8');
}

// -----------------------------------------------------------------------------
// Probe video
// -----------------------------------------------------------------------------

function probeVideo(file) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate,nb_frames',
            '-of', 'json',
            file,
        ]);

        let out = '';
        ffprobe.stdout.on('data', d => (out += d));
        ffprobe.stderr.on('data', d => process.stderr.write(d));

        ffprobe.on('close', () => {
            const json = JSON.parse(out);
            const s = json.streams[0];

            const [num, den] = s.r_frame_rate.split('/').map(Number);
            const fps = Math.round(num / den);

            resolve({
                width: s.width,
                height: s.height,
                fps,
                frames: Number(s.nb_frames),
            });
        });
    });
}

// -----------------------------------------------------------------------------
// RGB888 → RGB332 (IDENTICAL to ESP32)
// -----------------------------------------------------------------------------

function rgb888_to_rgb332(r, g, b) {
    return (r >> 5) | ((g >> 5) << 3) | (b & 0b11000000);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

(async () => {
    const { width, height, fps, frames } = await probeVideo(INPUT);

    const frameSizeRGB = width * height * 3;
    const frameSizeRV = width * height;

    console.log(`Input : ${INPUT}`);
    console.log(`Output: ${OUTPUT}`);
    console.log(`Video : ${width}x${height} @ ${fps}fps`);
    console.log(`Frames: ${frames}`);
    console.log(`Format: RGB332 (ESP32 native)`);

    const out = fs.openSync(OUTPUT, 'w');

    // -------------------------------------------------------------------------
    // Write RV v1 header
    // -------------------------------------------------------------------------

    /*
    RV v1 HEADER
    ----------------------------
    char[2]  "RV"
    uint8    version = 1
    uint16   width
    uint16   height
    uint16   fps
    uint32   frame_count
    uint8    bits_per_pixel
    */

    const header = Buffer.alloc(14);
    let o = 0;

    header.write('RV', o); o += 2;
    header.writeUInt8(1, o); o += 1;
    header.writeUInt16LE(width, o); o += 2;
    header.writeUInt16LE(height, o); o += 2;
    header.writeUInt16LE(fps, o); o += 2;
    header.writeUInt32LE(frames, o); o += 4;
    header.writeUInt8(BITS, o); o += 1;

    fs.writeSync(out, header);

    // -------------------------------------------------------------------------
    // ffmpeg raw RGB stream
    // -------------------------------------------------------------------------

    const ffmpeg = spawn('ffmpeg', [
        '-i', INPUT,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-vsync', '0',
        'pipe:1',
    ]);

    let rgbBuf = Buffer.alloc(0);
    let frameIndex = 0;

    ffmpeg.stdout.on('data', chunk => {
        rgbBuf = Buffer.concat([rgbBuf, chunk]);

        while (rgbBuf.length >= frameSizeRGB) {
            const frame = rgbBuf.subarray(0, frameSizeRGB);
            rgbBuf = rgbBuf.subarray(frameSizeRGB);

            const outFrame = Buffer.alloc(frameSizeRV);

            let si = 0;
            let di = 0;

            for (let i = 0; i < width * height; i++) {
                const r = frame[si++];
                const g = frame[si++];
                const b = frame[si++];

                outFrame[di++] = rgb888_to_rgb332(r, g, b);
            }

            fs.writeSync(out, outFrame);
            frameIndex++;

            if ((frameIndex & 15) === 0) {
                process.stdout.write(`\rFrame ${frameIndex}/${frames}`);
            }
        }
    });

    ffmpeg.stderr.on('data', d => process.stderr.write(d));

    ffmpeg.on('close', () => {
        fs.closeSync(out);
        console.log(`\nDONE ✔ ${OUTPUT}`);
    });
})();
