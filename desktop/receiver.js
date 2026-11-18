'use strict';

// Run the protocol stack and native Node dependencies in the bundled Node
// runtime. Losing the desktop parent's IPC channel also releases its receiver.
const { createAppServer } = require('../src/server');
const startup = createAppServer();
process.once('disconnect', async () => {
  const deadline = setTimeout(() => process.exit(1), 8000);
  try { await (await startup).close(); }
  finally { clearTimeout(deadline); process.exit(0); }
});
startup.then(() => {
  if (process.connected) process.send('ready');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
