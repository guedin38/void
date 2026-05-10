const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

(function patchNodeFetchResolveIfIncomplete() {
  const nfMain = path.join(__dirname, 'node_modules', 'node-fetch', 'lib', 'index.js');
  if (fs.existsSync(nfMain)) return;
  const Module = require('module');
  const orig = Module._resolveFilename.bind(Module);
  Module._resolveFilename = (request, parent, isMain, options) => {
    if (request === 'node-fetch') {
      return path.join(__dirname, 'node-fetch-native-shim.js');
    }
    return orig(request, parent, isMain, options);
  };
})();

const RPC = require('discord-rpc');

// Lance ton serveur Node.js (server.js) en arrière-plan
require('./server.js'); 

let win;
let miniBoundsBackup = null;

// ─── CONFIGURATION DISCORD ─────────────────────────────────────────────────
const clientId = '1499922100759040241'; // <--- Mets ton ID réel ici
const rpc = new RPC.Client({ transport: 'ipc' });

function updateDiscord(songTitle, artist) {
    if (!rpc || !win) return;
    rpc.setActivity({
        details: songTitle,
        state: `par ${artist}`,
        largeImageKey: 'logo', 
        largeImageText: 'VOID Player',
        instance: false,
    }).catch(err => console.log("Erreur RPC Discord:", err));
}

rpc.login({ clientId }).catch(() => console.log("Discord non détecté"));

// ─── CRÉATION DE LA FENÊTRE ────────────────────────────────────────────────
function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Void",
        minWidth: 800, // On remet des limites raisonnables puisqu'on a plus de mini
        minHeight: 600, 
        backgroundColor: '#0a0612',
        icon: path.join(__dirname, 'public/logo.png'),
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        titleBarOverlay: process.platform === 'win32' ? {
            color: 'rgba(0, 0, 0, 0)',
            symbolColor: '#ffffff',
            height: 40
        } : false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js') 
        }
    });

    win.setAspectRatio(1.5);
    win.setMenuBarVisibility(false);

    // ─── FONCTION DE ZOOM HYBRIDE (TON CODE ORIGINAL) ──────────────────────
    const updateZoom = () => {
        if (win.isDestroyed()) return;
        const { width } = win.getBounds();
        let finalZoom;

        if (width < 1150) {
            finalZoom = width / 1000; 
        } else {
            finalZoom = 1.15 + (width - 1150) / 3000; 
        }

        const clampedZoom = Math.min(Math.max(finalZoom, 0.6), 1.6);
        win.webContents.setZoomFactor(clampedZoom);
    };

    win.webContents.on('did-finish-load', updateZoom);
    win.on('resize', updateZoom);

    // Chargement de l'application
    win.loadURL('http://localhost:8080').catch(() => {
        setTimeout(() => win.loadURL('http://localhost:8080'), 1000);
    });
}

// ─── INTERACTIONS (IPC) ────────────────────────────────────────────────────

// On ne garde que Discord ici
ipcMain.on('update-rpc', (event, data) => {
    updateDiscord(data.title, data.artist);
});

ipcMain.handle('mini-player', async (event, { compact }) => {
    if (!win || win.isDestroyed()) return;
    try {
        if (compact) {
            // Sauvegarde la position/taille normale
            miniBoundsBackup = win.getBounds();
            // Mini mode : ratio libre, déplaçable, taille minimale raisonnable
            win.setAspectRatio(0);
            win.setResizable(true);
            win.setMovable(true);
            win.setMinimumSize(300, 420);
            win.setSize(400, 660);
            // Centrer la fenêtre mini à l'écran
            win.center();
        } else {
            // Retour mode normal
            win.setMinimumSize(800, 600);
            win.setAspectRatio(1.5);
            win.setResizable(true);
            win.setMovable(true);
            if (miniBoundsBackup) {
                win.setBounds(miniBoundsBackup);
                miniBoundsBackup = null;
            } else {
                win.setSize(1200, 800);
            }
        }
    } catch (e) {
        console.error('mini-player', e);
    }
});

// ─── CYCLE DE VIE ──────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});