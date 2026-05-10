const express  = require('express');

const http     = require('http');

const WebSocket = require('ws');

const { Server: SsdpServer } = require('node-ssdp');

const os       = require('os');

const { v4: uuidv4 } = require('uuid');

const xml2js   = require('xml2js');



const app    = express();

const server = http.createServer(app);

const wss    = new WebSocket.Server({ server });

const PORT   = 8080;

const DEVICE_UUID = uuidv4();



function getLocalIP() {

  for (const ifaces of Object.values(os.networkInterfaces()))

    for (const i of ifaces)

      if (i.family === 'IPv4' && !i.internal) return i.address;

  return '127.0.0.1';

}

const LOCAL_IP = getLocalIP();

const path = require('path');



// Indique à Express où trouver tes fichiers HTML/CSS/JS

app.use(express.static(path.join(__dirname, 'public')));



// Route par défaut qui renvoie ton fichier index.html

app.get('/', (req, res) => {

  res.sendFile(path.join(__dirname, 'public', 'index.html'));

});



// ── État global ──────────────────────────────────────────────────────────────

let state = {

  uri: null, status: 'STOPPED',

  title: '', artist: '', album: '', artUrl: '',

  volume: 100, duration: '0:00:00', position: '0:00:00',

  // Next track info (prefetched via SetNextAVTransportURI)

  nextUri: null, nextTitle: '', nextArtist: '', nextAlbum: '', nextArtUrl: '',

  /** Pistes déjà jouées (pour Précédent depuis l’UI ou SOAP) */
  trackHistory: [],

};



// ── WebSocket clients ────────────────────────────────────────────────────────

const wsClients = new Set();



function broadcast(data, except = null) {

  const msg = JSON.stringify(data);

  for (const ws of wsClients)

    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(msg);

}



function parsePositionSec(posStr) {

  if (!posStr || typeof posStr !== 'string') return 0;

  const p = posStr.trim().split(':').map((x) => parseInt(x, 10));

  if (p.some((n) => Number.isNaN(n))) return 0;

  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];

  if (p.length === 2) return p[0] * 60 + p[1];

  if (p.length === 1) return p[0];

  return 0;

}



/** Passe à la piste préchargée (SetNextAVTransportURI) et lance la lecture côté client. */
function applyNextTrack() {

  const nextU = (state.nextUri != null ? String(state.nextUri) : '').trim();

  if (!nextU) return false;

  state.uri = nextU;

  state.title = state.nextTitle;

  state.artist = state.nextArtist;

  state.album = state.nextAlbum;

  state.artUrl = state.nextArtUrl;

  state.nextUri = null;

  state.nextTitle = '';

  state.nextArtist = '';

  state.nextAlbum = '';

  state.nextArtUrl = '';

  state.status = 'PLAYING';

  state.position = '0:00:00';

  broadcast({

    type: 'load',

    uri: state.uri,

    title: state.title,

    artist: state.artist,

    album: state.album,

    artUrl: state.artUrl,

  });

  broadcast({ type: 'play' });

  return true;

}



/** Précédent : si >3 s dans la piste → début ; sinon piste de l’historique. */
function applyPreviousTrack() {

  const posSec = parsePositionSec(state.position);

  if (posSec > 3) {

    state.position = '0:00:00';

    broadcast({ type: 'seek', target: '0:00:00' });

    return;

  }

  const prev = state.trackHistory.pop();

  if (prev && prev.uri) {

    state.uri = prev.uri;

    state.title = prev.title || '';

    state.artist = prev.artist || '';

    state.album = prev.album || '';

    state.artUrl = prev.artUrl || '';

    state.nextUri = null;

    state.nextTitle = '';

    state.nextArtist = '';

    state.nextAlbum = '';

    state.nextArtUrl = '';

    state.status = 'PLAYING';

    state.position = '0:00:00';

    broadcast({

      type: 'load',

      uri: state.uri,

      title: state.title,

      artist: state.artist,

      album: state.album,

      artUrl: state.artUrl,

    });

    broadcast({ type: 'play' });

    return;

  }

  broadcast({ type: 'seek', target: '0:00:00' });

}



wss.on('connection', ws => {

  wsClients.add(ws);

  // Send current state to new client

  ws.send(JSON.stringify({ type: 'state', ...state }));



  ws.on('close', () => wsClients.delete(ws));

  ws.on('message', raw => {

    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'positionUpdate':

        state.position = msg.position || '0:00:00';

        state.duration = msg.duration || '0:00:00';

        break;

      case 'play':

        state.status = 'PLAYING';

        broadcast({ type: 'play' }, ws);

        break;

      case 'pause':

        state.status = 'PAUSED_PLAYBACK';

        broadcast({ type: 'pause' }, ws);

        break;

      case 'seek':

        broadcast({ type: 'seek', target: msg.target }, ws);

        break;

      case 'setVolume': {

        const v = Math.min(100, Math.max(0, parseInt(msg.value) || 0));

        state.volume = v;

        broadcast({ type: 'volume', value: v }, ws);

        break;

      }

      // --- AJOUT DES COMMANDES SUIVANT / PRÉCÉDENT ---

      case 'next':

        console.log('📡 Commande : Suivant');

        if (!applyNextTrack() && msg.preload && String(msg.preload.uri || '').trim()) {

          state.nextUri    = String(msg.preload.uri).trim();

          state.nextTitle  = String(msg.preload.title || '').trim();

          state.nextArtist = String(msg.preload.artist || '').trim();

          state.nextAlbum  = String(msg.preload.album || '').trim();

          state.nextArtUrl = String(msg.preload.artUrl || '').trim();

          applyNextTrack();

        }

        break;



      case 'previous':

        console.log('📡 Commande : Précédent');

        applyPreviousTrack();

        break;

      // -----------------------------------------------

      case 'trackEnded':

        if (state.nextUri) {

          applyNextTrack();

        } else {

          state.status = 'STOPPED';

          state.position = '0:00:00';

        }

        break;

    }

  });

});



// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.static('public'));

app.use(express.text({ type: '*/*', limit: '10mb' }));



// ── Proxy audio+images (CORS) ────────────────────────────────────────────────

app.get('/proxy', (req, res) => {

  const target = req.query.url;

  if (!target) return res.status(400).send('missing url');

  try {

    const parsed = new URL(target);

    const proto  = parsed.protocol === 'https:' ? require('https') : require('http');

    const opts   = {

      hostname: parsed.hostname,

      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),

      path:     parsed.pathname + parsed.search,

      headers:  { 'Range': req.headers['range'] || '', 'User-Agent': 'DLNA-Receiver/1.0' },

    };

    const pr = proto.get(opts, ps => {

      res.set('Access-Control-Allow-Origin', '*');

      res.set('Accept-Ranges', 'bytes');

      ['content-type','content-length','content-range','last-modified'].forEach(h => {

        if (ps.headers[h]) res.set(h, ps.headers[h]);

      });

      res.status(ps.statusCode);

      ps.pipe(res);

    });

    pr.on('error', e => { if (!res.headersSent) res.status(502).send('proxy error'); });

  } catch { res.status(400).send('invalid url'); }

});



// ── SOAP helpers ─────────────────────────────────────────────────────────────

function parseSoap(body, cb) {

  xml2js.parseString(body, { explicitArray: false, ignoreAttrs: false }, (err, r) => {

    if (err || !r) return cb(null, null);

    try {

      const env  = r['s:Envelope'] || r['SOAP-ENV:Envelope'] || Object.values(r)[0];

      const body = env['s:Body']   || env['SOAP-ENV:Body']   || Object.values(env)[0];

      const key  = Object.keys(body).find(k => !k.startsWith('@'));

      cb(key, body[key]);

    } catch { cb(null, null); }

  });

}



/** xml2js : texte dans _ ou chaîne directe, y compris objets imbriqués (SOAP UPnP). */
function soapScalar(val) {

  if (val == null) return '';

  if (typeof val === 'string' || typeof val === 'number') return String(val).trim();

  if (Array.isArray(val)) return soapScalar(val[0]);

  if (typeof val === 'object') {

    if (val._ !== undefined && val._ !== null && typeof val._ !== 'object') return String(val._).trim();

    for (const v of Object.values(val)) {

      const s = soapScalar(v);

      if (s) return s;

    }

  }

  return '';

}



/** Récupère un argument SOAP (ex. NextURI) — namespace, casse, imbrication xml2js. */
function soapPick(params, name, depth = 0) {

  if (depth > 12 || !params || typeof params !== 'object') return '';

  const want = String(name).toLowerCase();

  const keys = Object.keys(params).filter((k) => {

    if (k.startsWith('@')) return false;

    const local = k.replace(/^[^:]*:/, '').toLowerCase();

    return local === want || k.toLowerCase() === want;

  });

  for (const k of keys) {

    const raw = params[k];

    const s = soapScalar(Array.isArray(raw) ? raw[0] : raw);

    if (s) return s;

  }

  for (const v of Object.values(params)) {

    if (v && typeof v === 'object' && !Array.isArray(v)) {

      const inner = soapPick(v, name, depth + 1);

      if (inner) return inner;

    }

  }

  return '';

}



function soapOk(service, action, params = {}) {

  const ns    = `urn:schemas-upnp-org:service:${service}:1`;

  const inner = Object.entries(params).map(([k,v]) => `<${k}>${v}</${k}>`).join('\n      ');

  return `<?xml version="1.0" encoding="utf-8"?>

<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">

  <s:Body><u:${action}Response xmlns:u="${ns}">${inner}</u:${action}Response></s:Body>

</s:Envelope>`;

}
const https = require('https');

// Fonction pour récupérer les métadonnées et pochettes HD via iTunes
function getPremiumMetadata(title, artist) {
  return new Promise((resolve) => {
    // Nettoyage de la recherche
    const query = encodeURIComponent(`${title} ${artist}`).replace(/%20/g, '+');
    const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=1`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results.length > 0) {
            const track = json.results[0];
            resolve({
              title: track.trackName,
              artist: track.artistName,
              album: track.collectionName,
              // Astuce : on remplace 100x100 par 600x600 pour avoir une cover ultra HD !
              artUrl: track.artworkUrl100.replace('100x100bb', '600x600bb') 
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}



function extractMeta(metadata) {

  const info = { title:'', artist:'', album:'', artUrl:'' };

  if (!metadata) return info;

  const tag = t => { const m = metadata.match(new RegExp(`<${t}[^>]*>([^<]+)</${t}>`)); return m ? m[1] : ''; };

  info.title  = tag('dc:title')     || tag('title');

  info.artist = tag('upnp:artist')  || tag('dc:creator') || tag('artist');

  info.album  = tag('upnp:album')   || tag('album');

  const art   = metadata.match(/<upnp:albumArtURI[^>]*>([^<]+)<\/upnp:albumArtURI>/i)

             || metadata.match(/(https?:\/\/[^\s"<]+\.(?:jpe?g|png|gif|webp)[^\s"<]*)/i);

  info.artUrl = art ? art[1].trim() : '';

  return info;

}



// ── Device description XML ───────────────────────────────────────────────────

app.get('/description.xml', (_, res) => {

  res.set('Content-Type', 'text/xml; charset="utf-8"');

  res.send(`<?xml version="1.0"?>

<root xmlns="urn:schemas-upnp-org:device-1-0">

  <specVersion><major>1</major><minor>0</minor></specVersion>

  <device>

    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>

    <friendlyName>V . O . I . D</friendlyName>

    <manufacturer>Custom</manufacturer><modelName>BrowserRenderer</modelName>

    <UDN>uuid:${DEVICE_UUID}</UDN>

    <serviceList>

      <service>

        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>

        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>

        <SCPDURL>/scpd/avtransport.xml</SCPDURL>

        <controlURL>/control/avtransport</controlURL>

        <eventSubURL>/events/avtransport</eventSubURL>

      </service>

      <service>

        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>

        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>

        <SCPDURL>/scpd/renderingcontrol.xml</SCPDURL>

        <controlURL>/control/renderingcontrol</controlURL>

        <eventSubURL>/events/renderingcontrol</eventSubURL>

      </service>

      <service>

        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>

        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>

        <SCPDURL>/scpd/connectionmanager.xml</SCPDURL>

        <controlURL>/control/connectionmanager</controlURL>

        <eventSubURL>/events/connectionmanager</eventSubURL>

      </service>

    </serviceList>

  </device>

</root>`);

});



// ── AVTransport ──────────────────────────────────────────────────────────────
app.post('/control/avtransport', (req, res) => {
  res.set('Content-Type', 'text/xml; charset="utf-8"');
  const action = (req.headers['soapaction'] || '').toLowerCase();

  parseSoap(req.body, (_, params) => {
    
    // --- C'EST ICI QUE TOUT CHANGE POUR SMART VIEW ---
    // --- C'EST ICI QUE TOUT CHANGE POUR SAMSUNG MUSIC ---
// --- C'EST ICI QUE TOUT CHANGE POUR SAMSUNG MUSIC ---
// --- C'EST ICI QUE TOUT CHANGE POUR SAMSUNG MUSIC ---
if (action.includes('setavtransporturi')) {
  const uri  = soapPick(params, 'CurrentURI') || '';
  const rawMeta = soapPick(params, 'CurrentURIMetaData') || '';

  console.log("\n====== RAW XML DE SAMSUNG MUSIC ======");
  console.log(rawMeta);
  console.log("======================================\n");

  const meta = extractMeta(rawMeta);

  // 1. RÉPONSE IMMÉDIATE (Une seule fois !)
  res.send(soapOk('AVTransport', 'SetAVTransportURI'));

  // 2. TRAITEMENT EN ARRIÈRE-PLAN
  (async () => {
      // On priorise le titre du XML. S'il est absent, on tente l'URI en dernier recours.
      let finalTitle = meta.title && meta.title !== 'Piste inconnue' ? meta.title : '';
      let finalArtist = meta.artist || '';
      let finalCover = meta.artUrl || '';
      let finalAlbum = meta.album || '';

      // On nettoie le nom de fichier de l'URI UNIQUEMENT si on n'a toujours pas de bon titre ou d'artiste
      if (!finalTitle || finalTitle.includes('.mp3') || finalTitle.includes('.m4a') || !finalArtist) {
          let cleanName = decodeURIComponent(uri.split('/').pop().replace(/\.[^/.]+$/, ""));
          // On vérifie si cleanName n'est qu'un nombre (comme le -1005565075 de Samsung). Si oui, on l'ignore.
          if (isNaN(cleanName.replace(/^-/, ''))) {
              if (cleanName.includes('-')) {
                  let parts = cleanName.split('-');
                  if(!finalArtist) finalArtist = parts[0].trim();
                  if(!finalTitle) finalTitle = parts.slice(1).join('-').trim();
              } else if (!finalTitle) {
                  finalTitle = cleanName;
              }
          }
      }
      
      // Si on n'a TOUJOURS pas de titre, on utilise un texte par défaut
      if (!finalTitle) finalTitle = 'Piste inconnue';

      // TENTATIVE 1 : Tenter d'aspirer le MP3 en direct
      if (!finalArtist || !finalCover) {
          try {
              const mm = require('music-metadata');
              const audioMeta = await mm.fetchFromUrl(uri);
              if (audioMeta && audioMeta.common) {
                  if (audioMeta.common.title) finalTitle = audioMeta.common.title;
                  if (audioMeta.common.artist) finalArtist = audioMeta.common.artist;
                  if (audioMeta.common.album) finalAlbum = audioMeta.common.album;
                  if (audioMeta.common.picture && audioMeta.common.picture.length > 0) {
                      const pic = audioMeta.common.picture[0];
                      finalCover = `data:${pic.format};base64,${pic.data.toString('base64')}`;
                  }
              }
          } catch(err) {
              console.log("-> Samsung Music bloque la lecture directe ID3.");
          }
      }

      // TENTATIVE 2 : La magie d'iTunes pour boucher les trous restants !
      if (!finalCover || !finalArtist) {
          console.log(`-> Recherche iTunes de secours pour : ${finalTitle} ${finalArtist}`);
          
          await new Promise((resolve) => {
              const searchQuery = finalArtist ? `${finalTitle} ${finalArtist}` : finalTitle;
              const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&entity=song&limit=1`;
              
              const https = require('https');
              https.get(itunesUrl, (res) => {
                  let data = '';
                  res.on('data', chunk => data += chunk);
                  res.on('end', () => {
                      try {
                          const json = JSON.parse(data);
                          if (json.results && json.results.length > 0) {
                              const track = json.results[0];
                              finalTitle = track.trackName;
                              finalArtist = track.artistName;
                              finalAlbum = track.collectionName;
                              finalCover = track.artworkUrl100.replace('100x100bb', '600x600bb');
                          }
                          resolve();
                      } catch(e) { resolve(); }
                  });
              }).on('error', () => resolve());
          });
      }

      // Historique pour « Précédent » (téléphone ou UI)
      if (state.uri && state.uri !== uri) {
        state.trackHistory.push({
          uri: state.uri,
          title: state.title || '',
          artist: state.artist || '',
          album: state.album || '',
          artUrl: state.artUrl || '',
        });
        if (state.trackHistory.length > 50) state.trackHistory.shift();
      }

      // Mise à jour de l'état global
      state.uri    = uri;
      state.title  = finalTitle;
      state.artist = finalArtist;
      state.album  = finalAlbum;
      state.artUrl = finalCover;
      state.status = 'PAUSED_PLAYBACK';
      state.position = '0:00:00';
      
      // Envoi au navigateur PC
      broadcast({ type: 'load', uri, title: state.title, artist: state.artist, album: state.album, artUrl: state.artUrl });
  })();
  
  return; 
} 
// ------------------------------------------------- 
    // -------------------------------------------------

    else if (action.includes('setnextavtransporturi')) {
      // Samsung Music pre-loads the next track — store it for seamless transition
      const uri  = (soapPick(params, 'NextURI') || '').trim();
      const meta = extractMeta(soapPick(params, 'NextURIMetaData') || '');
      state.nextUri    = uri || null;
      state.nextTitle  = meta.title  || '';
      state.nextArtist = meta.artist || '';
      state.nextAlbum  = meta.album  || '';
      state.nextArtUrl = meta.artUrl || '';
      // Tell the browser to preload next track for crossfade
      broadcast({ type: 'preload', uri, title: state.nextTitle, artist: state.nextArtist, album: state.nextAlbum, artUrl: state.nextArtUrl });
      return res.send(soapOk('AVTransport', 'SetNextAVTransportURI'));

    } else if (action.includes('play')) {
      state.status = 'PLAYING';
      broadcast({ type: 'play' });
      return res.send(soapOk('AVTransport', 'Play'));

    } else if (action.includes('pause')) {
      state.status = 'PAUSED_PLAYBACK';
      broadcast({ type: 'pause' });
      return res.send(soapOk('AVTransport', 'Pause'));

    } else if (action.includes('stop')) {
      state.status = 'STOPPED';
      broadcast({ type: 'stop' });
      return res.send(soapOk('AVTransport', 'Stop'));

    } else if (action.includes('seek')) {
      const target = soapPick(params, 'Target') || soapPick(params, 'Unit') || '0:00:00';
      broadcast({ type: 'seek', target });
      return res.send(soapOk('AVTransport', 'Seek'));

    } else if (action.includes('avtransport:1#next') || action.includes('avtransport:2#next') || (action.includes('#next') && !action.includes('setnext'))) {
      applyNextTrack();
      return res.send(soapOk('AVTransport', 'Next'));

    } else if (action.includes('avtransport:1#previous') || action.includes('avtransport:2#previous')) {
      applyPreviousTrack();
      return res.send(soapOk('AVTransport', 'Previous'));

    } else if (action.includes('gettransportinfo')) {
      return res.send(soapOk('AVTransport', 'GetTransportInfo', {
        CurrentTransportState:  state.status,
        CurrentTransportStatus: 'OK',
        CurrentSpeed:           '1',
      }));

    } else if (action.includes('getpositioninfo')) {
      return res.send(soapOk('AVTransport', 'GetPositionInfo', {
        Track:         '1',
        TrackDuration: state.duration,
        TrackMetaData: '',
        TrackURI:      state.uri || '',
        RelTime:       state.position,
        AbsTime:       state.position,
        RelCount:      '0',
        AbsCount:      '0',
      }));

    } else if (action.includes('getmediainfo')) {
      return res.send(soapOk('AVTransport', 'GetMediaInfo', {
        NrTracks:          '1',
        MediaDuration:     state.duration,
        CurrentURI:        state.uri  || '',
        CurrentURIMetaData: '',
        NextURI:           state.nextUri || '',
        NextURIMetaData:   '',
        PlayMedium:        'NETWORK',
        RecordMedium:      'NOT_IMPLEMENTED',
        WriteStatus:       'NOT_IMPLEMENTED',
      }));

    } else if (action.includes('getdevicecapabilities')) {
      return res.send(soapOk('AVTransport', 'GetDeviceCapabilities', {
        PlayMedia:       'NETWORK',
        RecMedia:        'NOT_IMPLEMENTED',
        RecQualityModes: 'NOT_IMPLEMENTED',
      }));

    } else {
      return res.send(soapOk('AVTransport', 'Generic'));
    }
  });
});



// ── RenderingControl ─────────────────────────────────────────────────────────

app.post('/control/renderingcontrol', (req, res) => {

  res.set('Content-Type', 'text/xml; charset="utf-8"');

  const action = (req.headers['soapaction'] || '').toLowerCase();

  parseSoap(req.body, (_, params) => {

    if (action.includes('setvolume')) {

      const vol = parseInt(soapPick(params, 'DesiredVolume') || 100);

      state.volume = vol;

      broadcast({ type: 'volume', value: vol });

      return res.send(soapOk('RenderingControl', 'SetVolume'));

    } else if (action.includes('getvolume')) {

      return res.send(soapOk('RenderingControl', 'GetVolume', { CurrentVolume: state.volume }));

    } else if (action.includes('setmute')) {

      const mute = soapPick(params, 'DesiredMute') === '1';

      broadcast({ type: 'mute', value: mute });

      return res.send(soapOk('RenderingControl', 'SetMute'));

    }

    return res.send(soapOk('RenderingControl', 'Generic'));

  });

});



// ── ConnectionManager ────────────────────────────────────────────────────────

app.post('/control/connectionmanager', (req, res) => {

  res.set('Content-Type', 'text/xml; charset="utf-8"');

  res.send(soapOk('ConnectionManager', 'GetProtocolInfo', {

    Source: '',

    Sink: ['http-get:*:audio/mpeg:*','http-get:*:audio/mp4:*','http-get:*:audio/mp3:*',

           'http-get:*:audio/ogg:*','http-get:*:audio/wav:*','http-get:*:audio/flac:*',

           'http-get:*:audio/aac:*','http-get:*:audio/*:*'].join(','),

  }));

});



// ── Events & SCPD ────────────────────────────────────────────────────────────

app.all('/events/*', (req, res) => {

  res.set('SID', 'uuid:' + uuidv4());

  res.set('TIMEOUT', 'Second-1800');

  res.status(200).end();

});



const avScpd = `<?xml version="1.0" encoding="utf-8"?>

<scpd xmlns="urn:schemas-upnp-org:service-1-0">

  <specVersion><major>1</major><minor>0</minor></specVersion>

  <actionList>

    <action><name>SetAVTransportURI</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>CurrentURI</name><direction>in</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>

      <argument><name>CurrentURIMetaData</name><direction>in</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>SetNextAVTransportURI</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>NextURI</name><direction>in</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>

      <argument><name>NextURIMetaData</name><direction>in</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Play</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Speed</name><direction>in</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Pause</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Stop</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Seek</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Unit</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>

      <argument><name>Target</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Next</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>Previous</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>GetTransportInfo</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>CurrentTransportState</name><direction>out</direction><relatedStateVariable>TransportState</relatedStateVariable></argument>

      <argument><name>CurrentTransportStatus</name><direction>out</direction><relatedStateVariable>TransportStatus</relatedStateVariable></argument>

      <argument><name>CurrentSpeed</name><direction>out</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>GetPositionInfo</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Track</name><direction>out</direction><relatedStateVariable>CurrentTrack</relatedStateVariable></argument>

      <argument><name>TrackDuration</name><direction>out</direction><relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>

      <argument><name>TrackMetaData</name><direction>out</direction><relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>

      <argument><name>TrackURI</name><direction>out</direction><relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>

      <argument><name>RelTime</name><direction>out</direction><relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>

      <argument><name>AbsTime</name><direction>out</direction><relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>

      <argument><name>RelCount</name><direction>out</direction><relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>

      <argument><name>AbsCount</name><direction>out</direction><relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>GetMediaInfo</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>NrTracks</name><direction>out</direction><relatedStateVariable>NumberOfTracks</relatedStateVariable></argument>

      <argument><name>MediaDuration</name><direction>out</direction><relatedStateVariable>CurrentMediaDuration</relatedStateVariable></argument>

      <argument><name>CurrentURI</name><direction>out</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>

      <argument><name>CurrentURIMetaData</name><direction>out</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>

      <argument><name>NextURI</name><direction>out</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>

      <argument><name>NextURIMetaData</name><direction>out</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>

      <argument><name>PlayMedium</name><direction>out</direction><relatedStateVariable>PlaybackStorageMedium</relatedStateVariable></argument>

      <argument><name>RecordMedium</name><direction>out</direction><relatedStateVariable>RecordStorageMedium</relatedStateVariable></argument>

      <argument><name>WriteStatus</name><direction>out</direction><relatedStateVariable>RecordMediumWriteStatus</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>GetDeviceCapabilities</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>PlayMedia</name><direction>out</direction><relatedStateVariable>PossiblePlaybackStorageMedia</relatedStateVariable></argument>

      <argument><name>RecMedia</name><direction>out</direction><relatedStateVariable>PossibleRecordStorageMedia</relatedStateVariable></argument>

      <argument><name>RecQualityModes</name><direction>out</direction><relatedStateVariable>PossibleRecordQualityModes</relatedStateVariable></argument>

    </argumentList></action>

  </actionList>

  <serviceStateTable>

    <stateVariable><name>TransportState</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>TransportStatus</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>TransportPlaySpeed</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>NumberOfTracks</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>ui4</dataType></stateVariable>

    <stateVariable><name>CurrentTrack</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>ui4</dataType></stateVariable>

    <stateVariable><name>CurrentTrackDuration</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>CurrentMediaDuration</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>CurrentTrackMetaData</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>CurrentTrackURI</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>AVTransportURI</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>AVTransportURIMetaData</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>NextAVTransportURI</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>NextAVTransportURIMetaData</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>PlaybackStorageMedium</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>RecordStorageMedium</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>PossiblePlaybackStorageMedia</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>PossibleRecordStorageMedia</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>RecordMediumWriteStatus</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>PossibleRecordQualityModes</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>RelativeTimePosition</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>AbsoluteTimePosition</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>RelativeCounterPosition</name><sendEventsAttribute>no</sendEventsAttribute><dataType>i4</dataType></stateVariable>

    <stateVariable><name>AbsoluteCounterPosition</name><sendEventsAttribute>no</sendEventsAttribute><dataType>i4</dataType></stateVariable>

    <stateVariable><name>A_ARG_TYPE_SeekMode</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>A_ARG_TYPE_SeekTarget</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>A_ARG_TYPE_InstanceID</name><sendEventsAttribute>no</sendEventsAttribute><dataType>ui4</dataType></stateVariable>

  </serviceStateTable>

</scpd>`;



const rcScpd = `<?xml version="1.0" encoding="utf-8"?>

<scpd xmlns="urn:schemas-upnp-org:service-1-0">

  <specVersion><major>1</major><minor>0</minor></specVersion>

  <actionList>

    <action><name>GetVolume</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>

      <argument><name>CurrentVolume</name><direction>out</direction><relatedStateVariable>Volume</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>SetVolume</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>

      <argument><name>DesiredVolume</name><direction>in</direction><relatedStateVariable>Volume</relatedStateVariable></argument>

    </argumentList></action>

    <action><name>SetMute</name><argumentList>

      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>

      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>

      <argument><name>DesiredMute</name><direction>in</direction><relatedStateVariable>Mute</relatedStateVariable></argument>

    </argumentList></action>

  </actionList>

  <serviceStateTable>

    <stateVariable><name>Volume</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>ui2</dataType></stateVariable>

    <stateVariable><name>Mute</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>boolean</dataType></stateVariable>

    <stateVariable><name>A_ARG_TYPE_Channel</name><sendEventsAttribute>no</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>A_ARG_TYPE_InstanceID</name><sendEventsAttribute>no</sendEventsAttribute><dataType>ui4</dataType></stateVariable>

  </serviceStateTable>

</scpd>`;



const cmScpd = `<?xml version="1.0" encoding="utf-8"?>

<scpd xmlns="urn:schemas-upnp-org:service-1-0">

  <specVersion><major>1</major><minor>0</minor></specVersion>

  <actionList>

    <action><name>GetProtocolInfo</name><argumentList>

      <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>

      <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>

    </argumentList></action>

  </actionList>

  <serviceStateTable>

    <stateVariable><name>SourceProtocolInfo</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>SinkProtocolInfo</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

    <stateVariable><name>CurrentConnectionIDs</name><sendEventsAttribute>yes</sendEventsAttribute><dataType>string</dataType></stateVariable>

  </serviceStateTable>

</scpd>`;



app.get('/scpd/avtransport.xml',      (_, r) => { r.set('Content-Type','text/xml'); r.send(avScpd); });

app.get('/scpd/renderingcontrol.xml', (_, r) => { r.set('Content-Type','text/xml'); r.send(rcScpd); });

app.get('/scpd/connectionmanager.xml',(_, r) => { r.set('Content-Type','text/xml'); r.send(cmScpd); });



// ── Quit ─────────────────────────────────────────────────────────────────────

app.post('/quit', (req, res) => {

  res.json({ ok: true });

  broadcast({ type: 'shutdown' });

  setTimeout(() => process.exit(0), 300);

});



// ── Lyrics via LRCLIB ────────────────────────────────────────────────────────

app.get('/lyrics', async (req, res) => {

  const { title, artist, album } = req.query;

  if (!title) return res.json({ found: false });

  try {

    const params = new URLSearchParams({ track_name: title });

    if (artist) params.set('artist_name', artist);

    if (album)  params.set('album_name', album);

    const url = `https://lrclib.net/api/get?${params}`;

    const data = await new Promise((resolve, reject) => {

      require('https').get(url, { headers: { 'User-Agent': 'DLNA-Browser-Receiver/1.0' } }, (r) => {

        let body = '';

        r.on('data', d => body += d);

        r.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });

      }).on('error', reject);

    });

    if (data && data.syncedLyrics) return res.json({ found: true, synced: data.syncedLyrics, plain: data.plainLyrics || '' });

    if (data && data.plainLyrics)  return res.json({ found: true, synced: null, plain: data.plainLyrics });

    res.json({ found: false });

  } catch (e) { res.json({ found: false }); }

});

// ── TRADUCTION DES PAROLES VIA GOOGLE TRANSLATE ─────────────────────────────
// ── TRADUCTION DES PAROLES VIA GOOGLE TRANSLATE ─────────────────────────────
app.post('/translate', async (req, res) => {
  try {
    const lines = JSON.parse(req.body);
    const textToTranslate = lines.join('\n');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=fr&dt=t&q=${encodeURIComponent(textToTranslate)}`;
    
    const https = require('https');
    https.get(url, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          
          // result[2] contient la langue détectée par Google (ex: "en", "es", "fr")
          const detectedLang = result[2]; 
          
          if (detectedLang === 'fr') {
            // C'est déjà du français ! On prévient l'application.
            res.json({ isFrench: true });
          } else {
            let translatedText = '';
            result[0].forEach(segment => { if (segment[0]) translatedText += segment[0]; });
            const translatedLines = translatedText.split('\n');
            res.json({ translated: translatedLines, isFrench: false });
          }
        } catch(e) { res.status(500).json({ error: 'Erreur parsing traduction' }); }
      });
    }).on('error', () => res.status(500).json({ error: 'Erreur requête' }));
  } catch (e) {
    res.status(400).json({ error: 'Payload invalide' });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {

  console.log('\n╔══════════════════════════════════════════════╗');

  console.log('║     🎵  DLNA Browser Receiver  démarré      ║');

  console.log('╠══════════════════════════════════════════════╣');

  console.log(`║  → http://${LOCAL_IP}:${PORT}`.padEnd(46) + '║');

  console.log('║  Samsung Music > Cast > 🎵 Browser Receiver ║');

  console.log('╚══════════════════════════════════════════════╝\n');

});



const ssdp = new SsdpServer({

  location: `http://${LOCAL_IP}:${PORT}/description.xml`,

  udn: `uuid:${DEVICE_UUID}`,

  adInterval: 3000, ttl: 4, allowWildcards: true,

});

ssdp.addUSN('upnp:rootdevice');

ssdp.addUSN(`uuid:${DEVICE_UUID}`);

ssdp.addUSN('urn:schemas-upnp-org:device:MediaRenderer:1');

ssdp.addUSN('urn:schemas-upnp-org:service:AVTransport:1');

ssdp.addUSN('urn:schemas-upnp-org:service:RenderingControl:1');

ssdp.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1');

ssdp.start().then(() => console.log('📡 SSDP actif\n')).catch(console.error);