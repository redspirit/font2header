#!/usr/bin/env node

const path = require('path');
const { convertToHeader, convertToPNG } = require('./converter');
const args = require('minimist')(process.argv.slice(2));

let font = args.font;
let out = args.out;
const width = Number(args.width || 8);
const scale = Number(args.scale || 1);

if (!font || !width) {
    console.error('Usage: --font --out --width(4..8)');
    process.exit(1);
}

if (!out) {
    out = path.parse(font).name;
} else {
    out = path.parse(out).name;
}

if (width < 4 || width > 8) {
    console.error('Width must be between 4 and 8');
    process.exit(1);
}

if (scale < 1 || scale > 8) {
    console.error('Scale must be 1-8');
    process.exit(1);
}

(async function() {
    await convertToPNG(font, out + '.png', width, scale);
    await convertToHeader(font, out + '.h', width);
})()
