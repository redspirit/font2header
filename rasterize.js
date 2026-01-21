const { createCanvas } = require('canvas');

/**
 * Растеризует opentype.js glyph в массив из 8 байт
 *
 * @param {opentype.Glyph} glyph
 * @param {number} width  - 4..8
 * @returns {number[]}    - массив из 8 байт
 */
function rasterizeGlyph(glyph, width) {
    const height = 8;

    // холст чуть шире — для центрирования
    const canvas = createCanvas(16, height);
    const ctx = canvas.getContext('2d');

    // очистка
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // рисуем глиф
    ctx.fillStyle = 'black';

    // базовая линия — низ символа
    const baseline = height;

    // масштаб фиксированный (8px по высоте)
    const fontSize = 8;

    // bbox глифа
    const bbox = glyph.getBoundingBox();

    // защита от пустых символов
    if (!isFinite(bbox.x1) || !isFinite(bbox.x2) || bbox.x1 === bbox.x2) {
        return new Array(8).fill(0);
    }

    const glyphWidth = bbox.x2 - bbox.x1;

    // горизонтальное центрирование
    const xOffset = Math.floor((canvas.width - glyphWidth) / 2 - bbox.x1);

    glyph.draw(ctx, xOffset, baseline, fontSize);

    const image = ctx.getImageData(0, 0, canvas.width, height).data;

    // поиск реальной области по X
    let minX = canvas.width - 1;
    let maxX = 0;
    let hasPixel = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const a = image[(y * canvas.width + x) * 4 + 3];
            if (a > 128) {
                hasPixel = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
    }

    if (!hasPixel) {
        return new Array(8).fill(0);
    }

    // центрируем финальное окно width
    const usedWidth = maxX - minX + 1;
    let startX = minX;

    if (usedWidth < width) {
        startX = minX - Math.floor((width - usedWidth) / 2);
    }

    if (startX < 0) startX = 0;
    if (startX + width > canvas.width) {
        startX = canvas.width - width;
    }

    // упаковка в байты
    const bytes = [];

    for (let y = 0; y < height; y++) {
        let byte = 0;
        for (let x = 0; x < width; x++) {
            const px = startX + x;
            const a = image[(y * canvas.width + px) * 4 + 3];
            if (a > 128) {
                byte |= 1 << (7 - x);
            }
        }
        bytes.push(byte);
    }

    return bytes;
}

/**
 * Рисует bitmap (8 байт) в canvas
 * Используется для PNG-превью и псевдографики
 */
function drawBitmap(ctx, ox, oy, bytes, width) {
    ctx.fillStyle = 'black';
    for (let y = 0; y < 8; y++) {
        let row = bytes[y];
        for (let x = 0; x < width; x++) {
            if (row & (1 << (7 - x))) {
                ctx.fillRect(ox + x, oy + y, 1, 1);
            }
        }
    }
}

module.exports = {
    rasterizeGlyph,
    drawBitmap,
};
