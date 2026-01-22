function printChar(buffer, width = 8) {
    let output = '';

    for (const byte of buffer) {
        const binary = (byte & 0xff).toString(2).padStart(8, '0').slice(0, width);
        const line = binary.replace(/1/g, '█').replace(/0/g, '.');
        output += line.split('').join(' ') + '\n';
    }

    console.log(output);
}

module.exports = printChar;
