#!/usr/bin/env node
const { convert } = require('./converter');

const args = require('minimist')(process.argv.slice(2));

if (!args.font || !args.out || !args.width) {
    console.error('Usage: --font --out --width(4..8)');
    process.exit(1);
}

convert(args.font, args.out, Number(args.width));
