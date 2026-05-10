const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    updateDiscord: (title, artist) => ipcRenderer.send('update-rpc', { title, artist }),
    setMiniPlayer: (compact) => ipcRenderer.invoke('mini-player', { compact })
});