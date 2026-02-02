const fs = require('fs');
const freetype = require('freetype2');
const { createCanvas } = require('canvas');
const cp866 = require('./cp866');
// const pseudo = require('./pseudographics');
const { drawBitmap } = require('./rasterize');
const { writeHeader } = require('./utils/headerWriter');

async function convertToPNG(fontPath, outPath, width, scale) {
    const face = freetype.NewFace(fontPath);

    const cellH = 8;
    const cellW = width;
    face.setPixelSizes(cellW, cellH);

    const srcW = 16 * cellW;
    const srcH = 16 * cellH;
    const srcCanvas = createCanvas(srcW, srcH);
    const srcCtx = srcCanvas.getContext('2d');

    srcCtx.clearRect(0, 0, srcW, srcH);
    srcCtx.fillStyle = 'black';

    for (let code = 0; code < 256; code++) {
        const x = (code % 16) * cellW;
        const y = Math.floor(code / 16) * cellH;

        let bitmap;

        const unicode = cp866[code] || 0x20;
        const glyph = face.loadChar(code, {
            render: true,
            loadTarget: freetype.RenderMode.MONO,
        });
        const bm = glyph.bitmap;
        bitmap = [...bm.buffer];

        drawBitmap(srcCtx, x, y, bitmap, width);
    }

    // масштабирование PNG (ТОЛЬКО ВИЗУАЛЬНО)
    if (scale === 1) {
        fs.writeFileSync(outPath, srcCanvas.toBuffer('image/png'));
        return;
    }

    const dstCanvas = createCanvas(srcW * scale, srcH * scale);
    const dstCtx = dstCanvas.getContext('2d');

    dstCtx.imageSmoothingEnabled = false;
    dstCtx.drawImage(srcCanvas, 0, 0, srcW, srcH, 0, 0, dstCanvas.width, dstCanvas.height);

    fs.writeFileSync(outPath, dstCanvas.toBuffer('image/png'));
    console.log(`PNG preview written to ${outPath} (scale ${scale}x)`);
}

async function convertToHeader(fontPath, outPath, width) {
    const face = freetype.NewFace(fontPath);
    let result = [];

    const cellH = 8;
    const cellW = width;
    face.setPixelSizes(cellW, cellH);

    for (let code = 0; code < 256; code++) {
        let bitmap;

        const unicode = cp866[code] || 0x20;
        const glyph = face.loadChar(code, {
            render: true,
            loadTarget: freetype.RenderMode.MONO,
        });
        const bm = glyph.bitmap;
        bitmap = [...bm.buffer];

        result.push(bitmap);
    }

    writeHeader(outPath, result);
}

module.exports = {
    convertToHeader,
    convertToPNG,
};
