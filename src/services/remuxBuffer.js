const { PassThrough } = require('stream');
const { Mp4Timeline } = require('./mp4Timeline');

// Ready-to-play fMP4 gets its own bounded reserve. Browser backpressure should
// not stop FFmpeg before it can turn the downloaded original into playable data.
class RemuxBuffer extends PassThrough {
  constructor({ live = false, maxBytes = live ? 256 * 1024 : 64 * 1024 * 1024 } = {}) {
    super({ readableHighWaterMark: maxBytes, writableHighWaterMark: 64 * 1024 });
    this.maxBytes = maxBytes;
    this.timeline = new Mp4Timeline();
  }
  _transform(chunk, encoding, callback) { this.timeline.write(chunk); super._transform(chunk, encoding, callback); }

  stats() {
    return { bytes: this.destroyed ? 0 : this.readableLength, maxBytes: this.maxBytes, ranges: this.destroyed ? [] : this.timeline.ranges() };
  }
}

module.exports = { RemuxBuffer };
