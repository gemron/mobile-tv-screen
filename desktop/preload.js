'use strict';
const { contextBridge } = require('electron');
const prefix = '--mobiletv-double-click-ms=';
const interval = Number(process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length));
contextBridge.exposeInMainWorld('mobileTVDoubleClickMs', interval);
