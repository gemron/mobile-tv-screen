const { crc32, deflateRawSync } = require('zlib');
function zipSubtitles(files) {
  const entries = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), body = Buffer.from(value), packed = deflateRawSync(body), header = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(body);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8); header.writeUInt32LE(crc,14); header.writeUInt32LE(packed.length,18); header.writeUInt32LE(body.length,22); header.writeUInt16LE(filename.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    entries.push(header,filename,packed);directory.push(central,filename);offset+=header.length+filename.length+packed.length;
  }
  const table=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...entries,table,end]);
}
module.exports={zipSubtitles};
