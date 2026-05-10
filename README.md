# V . O . I . D

**DLNA Audio Renderer** — Electron app that turns your PC or Mac into a DLNA/UPnP audio renderer (compatible Samsung Music, BubbleUPnP, etc.)

---

## Features

- 🎵 DLNA / UPnP MediaRenderer (AVTransport + RenderingControl + ConnectionManager)
- 🔊 WebSocket real-time sync between DLNA controller and browser UI
- 🎨 Automatic album art via iTunes API fallback
- 📝 Synced lyrics via LRCLIB
- 🌍 Lyrics translation via Google Translate
- 🎮 Discord Rich Presence integration
- 🔁 Next/Previous track with history

---

## Build locally

```bash
npm install
npm start                # Development
npm run build:win        # Windows zip + NSIS installer
npm run build:mac        # macOS dmg + zip (requires macOS)
```

## CI/CD — GitHub Actions

Every push triggers an automatic build:

- **macOS** → `.dmg` (x64 + arm64) + `.zip` — built on `macos-14` runner
- **Windows** → `.zip` + `.exe` installer — built on `windows-latest`

Download artifacts from **Actions → [run] → Artifacts**.

---

## Stack

`Electron` · `Express` · `WebSocket (ws)` · `node-ssdp` · `discord-rpc` · `xml2js` · `music-metadata`
