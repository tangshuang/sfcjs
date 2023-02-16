const { bundle } = require('../../bundler');
const path = require('path');
const fs = require('fs');

function build(entry, output) {
  const code = bundle(entry, {
    outputDir: __dirname,
    ignores: [
      entry,
    ],
    macro: true,
  });
  fs.writeFileSync(output, code);
}

build(path.resolve(__dirname, './index.htm'), path.resolve(__dirname, 'bundle.js'));
