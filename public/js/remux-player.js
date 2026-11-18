// Append the receiver's fragmented MP4 to a seekable MediaSource. A native
// chunked response can expose only a couple of seconds and no seekable range.
(() => {
  'use strict';
  function boxes(bytes, type, offset = 0) {
    const matches = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 8 <= bytes.length) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > bytes.length) break;
      const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (name === type) matches.push(bytes.subarray(offset + 8, offset + size));
      offset += size;
    }
    return matches;
  }

  function videoCodec(entry, name) {
    const hex = value => value.toString(16).padStart(2, '0');
    if (name === 'avc1' || name === 'avc3') {
      const config = boxes(entry, 'avcC', 78)[0];
      if (config?.length >= 4) return name + '.' + Array.from(config.subarray(1, 4), hex).join('');
    }
    if (name === 'hev1' || name === 'hvc1') {
      const config = boxes(entry, 'hvcC', 78)[0];
      if (config?.length >= 13) {
        const profile = ['', 'A', 'B', 'C'][config[1] >> 6] + (config[1] & 31);
        let flags = 0;
        for (let bit = 0; bit < 32; bit++) flags = flags * 2 + ((config[5 - (bit >> 3)] >> (bit % 8)) & 1);
        const constraints = Array.from(config.subarray(6, 12));
        while (constraints.length && !constraints.at(-1)) constraints.pop();
        return [name, profile, flags.toString(16), (config[1] & 32 ? 'H' : 'L') + config[12], ...constraints.map(hex)].join('.');
      }
    }
    throw new Error('Unsupported remux video codec');
  }

  function mimeType(moov) {
    const codecs = [];
    for (const track of boxes(moov, 'trak')) {
      const tables = ['mdia', 'minf', 'stbl', 'stsd'].reduce((parents, name) => parents.flatMap(bytes => boxes(bytes, name)), [track]);
      const table = tables[0];
      if (!table || table.length < 16) throw new Error('Missing remux sample description');
      const name = String.fromCharCode(...table.subarray(12, 16));
      // The receiver encodes its selected audio track as AAC-LC.
      codecs.push(name === 'mp4a' ? 'mp4a.40.2' : videoCodec(boxes(table, name, 8)[0], name));
    }
    return 'video/mp4; codecs="' + codecs.join(',') + '"';
  }

  function open(video, url, duration, onFailure) {
    const source = new MediaSource();
    const objectUrl = URL.createObjectURL(source);
    const controller = new AbortController();
    const { signal } = controller;
    let buffer;

    // Closing a player must also settle any wait for an append or for room.
    function next(target, events) {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const finish = event => {
          for (const name of events) target.removeEventListener(name, finish);
          signal.removeEventListener('abort', finish);
          if (signal.aborted || event.type === 'error') reject(signal.reason || new Error('Remux append failed'));
          else resolve();
        };
        for (const name of events) target.addEventListener(name, finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    }

    async function read() {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error('Remux request failed');
      const reader = response.body.getReader();
      let initial = new Uint8Array(0);
      for (;;) {
        if (buffer?.buffered.length) {
          const ranges = buffer.buffered;
          // Keep a short browser window. Backpressure leaves the rest in
          // the receiver reserve. Seeking ahead wakes the reader even paused.
          if (ranges.end(ranges.length - 1) > video.currentTime + 12) {
            await next(video, ['timeupdate', 'seeking']);
            continue;
          }
          const trim = Math.min(video.currentTime - 30, ranges.end(ranges.length - 1) - 15);
          if (trim >= ranges.start(0) + 10) {
            buffer.remove(0, trim);
            await next(buffer, ['updateend', 'error']);
          }
        }
        let { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          if (!buffer) throw new Error('Missing remux initialization');
          source.endOfStream();
          return;
        }
        if (!buffer) {
          const joined = new Uint8Array(initial.length + value.length);
          joined.set(initial); joined.set(value, initial.length);
          const moov = boxes(joined, 'moov')[0];
          if (!moov) {
            if (joined.length > 2 * 1024 * 1024) throw new Error('Remux initialization too large');
            initial = joined;
            continue;
          }
          buffer = source.addSourceBuffer(mimeType(moov));
          source.duration = duration > 0 ? duration : Infinity;
          initial = null;
          value = joined;
        }
        try {
          buffer.appendBuffer(value);
        } catch (error) {
          // High-bitrate video can reach the browser byte quota well before
          // the regular time-based history trim. Keep keyframe preroll.
          const end = buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0;
          const trim = Math.min(video.currentTime, end) - 5;
          if (error.name !== 'QuotaExceededError' || !buffer.buffered.length || trim <= buffer.buffered.start(0)) throw error;
          buffer.remove(0, trim);
          await next(buffer, ['updateend', 'error']);
          buffer.appendBuffer(value);
        }
        await next(buffer, ['updateend', 'error']);
      }
    }
    source.addEventListener('sourceopen', () => {
      read().catch(() => { if (!signal.aborted) onFailure(); });
    }, { once: true, signal });
    video.src = objectUrl;
    return {
      seekPrepared(relative, ranges, base) {
        if (!buffer?.buffered.length || source.readyState !== 'open') return false;
        const tail = buffer.buffered.end(buffer.buffered.length - 1);
        if (relative < tail || !ranges.some(([start, end]) => start <= tail + base + .25 && relative + base < end)) return false;
        // Unknown-length streams need a seekable bound beyond the last append.
        if (!Number.isFinite(source.duration)) {
          if (!source.setLiveSeekableRange) return false;
          source.setLiveSeekableRange(0, relative + 1);
        }
        video.currentTime = relative;
        return true;
      },
      destroy() { controller.abort(); URL.revokeObjectURL(objectUrl); },
    };
  }
  window.MobileTVRemuxPlayer = window.MediaSource && { open };
})();
