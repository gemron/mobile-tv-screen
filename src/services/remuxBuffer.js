const { PassThrough } = require('stream');

// Ready-to-play fMP4 gets its own bounded reserve. Browser backpressure should
// not stop FFmpeg before it can turn the downloaded original into playable data.
class RemuxBuffer extends PassThrough {
  constructor({ live = false, maxBytes = live ? 256 * 1024 : 64 * 1024 * 1024 } = {}) {
    super({ readableHighWaterMark: maxBytes, writableHighWaterMark: 64 * 1024 });
    this.maxBytes = maxBytes;
  }

  stats() {
    return { bytes: this.destroyed ? 0 : this.readableLength, maxBytes: this.maxBytes };
  }
}

module.exports = { RemuxBuffer };
