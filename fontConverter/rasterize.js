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
    drawBitmap,
};
