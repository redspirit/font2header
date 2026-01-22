#!/usr/bin/env node

const { convertToHeader, convertToPNG } = require('./converter');
const args = require('minimist')(process.argv.slice(2));

const font = args.font;
const out = args.out;
const width = Number(args.width || 8);
const format = args.format || 'h';
const scale = Number(args.scale || 1);

if (!font || !out || !width) {
    console.error('Usage: --font --out --width(4..8) [--format h|png]');
    process.exit(1);
}

if (width < 4 || width > 8) {
    console.error('Width must be between 4 and 8');
    process.exit(1);
}

if (scale < 1 || scale > 8) {
    console.error('Scale must be 1-8');
    process.exit(1);
}

if (format === 'png') {
    convertToPNG(font, out, width, scale);
} else {
    convertToHeader(font, out, width);
}
