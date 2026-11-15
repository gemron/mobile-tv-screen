const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.resolve(process.env.MOBILETV_DATA_DIR || path.join(ROOT_DIR, 'data'));

module.exports = { ROOT_DIR, DATA_DIR };
