const opentype = require('opentype.js');
const { createCanvas } = require('canvas');
const cp866 = require('./cp866');
const pseudo = require('./pseudographics');

async function convert(fontPath, outPath, width) {
    const font = await opentype.load(fontPath);

    const result = [];

    for (let code = 0; code < 256; code++) {
        if (pseudo[code]) {
            result.push(pseudo[code]);
            continue;
        }

        const unicode = cp866[code] || 32;
        const glyph = font.charToGlyph(String.fromCharCode(unicode));

        const canvas = createCanvas(width, 8);
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, width, 8);
        ctx.fillStyle = 'black';

        glyph.draw(ctx, 0, 8, 8);

        const img = ctx.getImageData(0, 0, width, 8);
        result.push(bitmapToBytes(img, width));
    }

    writeHeader(outPath, result);
}

module.exports = {
    convert
}