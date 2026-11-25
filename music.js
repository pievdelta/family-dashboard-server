// Music on the TVs (server 5.12, optional): the server becomes a speaker that phones can
// play to, and every TV that's showing Family Dashboard plays along.
//
//   Spotify: go-librespot (https://github.com/devgianlu/go-librespot) shows this computer
//            in the Spotify app's device list as "Family Dashboard". Needs Spotify Premium.
//   AirPlay: shairport-sync (https://github.com/mikebrady/shairport-sync) shows it as an
//            AirPlay speaker on iPhones, iPads and Macs.
//
// Neither program ships with the server: a family installs the ones it wants (on a Mac,
// "brew install go-librespot" and "brew install shairport-sync") and turns music on on the
// setup page. Both hand this server raw audio (16-bit, 44.1 kHz, stereo); the server
// encodes it once as MP3 and streams it to every TV at /api/music/stream.mp3.
// Settings live in music.json next to config.txt.

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { Mp3Encoder } from '@breezystack/lamejs';

const RATE = 44100;
const BYTES_PER_SEC = RATE * 4;           // 16-bit stereo
const FRAME = 1152;                       // samples per MP3 frame
const FRAME_BYTES = FRAME * 4;
const START_BUFFER = BYTES_PER_SEC * 0.3; // wait for this much before playing a source, to ride out hiccups
const HIGH_WATER = BYTES_PER_SEC * 1.5;   // stop reading a source past this (it waits; nothing is skipped)
const LOW_WATER = BYTES_PER_SEC * 0.75;
const QUIET_AFTER = 2500;                 // ms without audio before a source counts as stopped
const PREBUFFER_FRAMES = Math.round(1.0 * RATE / FRAME); // MP3 a new TV gets right away, so it starts quickly

export const SOURCES = {
  spotify: { name: 'Spotify', program: 'go-librespot', brew: 'brew install go-librespot', site: 'https://github.com/devgianlu/go-librespot' },
  airplay: { name: 'AirPlay', program: 'shairport-sync', brew: 'brew install shairport-sync', site: 'https://github.com/mikebrady/shairport-sync' }
};

export const MUSIC_DEFAULTS = { enabled: false, name: 'Family Dashboard', spotify: true, airplay: true, kbps: 160 };

export function readMusicSettings(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      enabled: j.enabled === true,
      name: cleanName(j.name) || MUSIC_DEFAULTS.name,
      spotify: j.spotify !== false,
      airplay: j.airplay !== false,
      kbps: [128, 160, 192, 256].includes(Number(j.kbps)) ? Number(j.kbps) : MUSIC_DEFAULTS.kbps
    };
  } catch (e) {
    return { ...MUSIC_DEFAULTS };
  }
}

export function saveMusicSettings(file, s) {
  const clean = { ...readMusicSettings('/nonexistent'), ...s };
  clean.name = cleanName(clean.name) || MUSIC_DEFAULTS.name;
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

/** A speaker name phones can show: letters, numbers, spaces and a little punctuation. */
export function cleanName(s) {
  return String(s ?? '').replace(/[^\p{L}\p{N} '&._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Where a program is: the server's addons folder, the usual Homebrew and system folders, then PATH. */
export function findProgram(program, { addonsDir = '', env = process.env, exists = fs.existsSync } = {}) {
  const dirs = [addonsDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', ...String(env.PATH || '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, program);
    if (exists(p)) return p;
  }
  return null;
}

// ---- audio coming in from one source -------------------------------------------------------

/** Raw audio from one program, buffered; asks the program to wait when the buffer is full. */
export class PcmSource extends EventEmitter {
  constructor(id, now = () => Date.now()) {
    super();
    this.id = id;
    this.now = now;
    this.chunks = [];
    this.bytes = 0;
    this.lastDataAt = 0;
    this.startedAt = 0;   // when this stretch of audio began (for picking which source plays)
    this.ready = false;   // has enough buffered to start
    this.stream = null;
    this.paused = false;
    this.odd = null;      // a leftover partial sample, kept for the next chunk
  }

  attach(stream) {
    this.stream = stream;
    stream.on('data', (b) => this.push(b));
  }

  push(b) {
    if (this.odd) { b = Buffer.concat([this.odd, b]); this.odd = null; }
    const extra = b.length % 4;
    if (extra) { this.odd = Buffer.from(b.subarray(b.length - extra)); b = b.subarray(0, b.length - extra); }
    if (!b.length) return;
    const t = this.now();
    if (!this.playing(t)) { this.startedAt = t; this.ready = false; }
    this.lastDataAt = t;
    this.chunks.push(b);
    this.bytes += b.length;
    if (!this.ready && this.bytes >= START_BUFFER) this.ready = true;
    if (this.bytes > HIGH_WATER && this.stream && !this.paused) { this.paused = true; this.stream.pause(); }
    this.emit('audio');
  }

  playing(t = this.now()) {
    return this.lastDataAt > 0 && t - this.lastDataAt < QUIET_AFTER;
  }

  /** Up to n bytes (a whole number of samples), or fewer when the buffer runs low. */
  take(n) {
    const out = [];
    let got = 0;
    while (got < n && this.chunks.length) {
      const c = this.chunks[0];
      const want = n - got;
      if (c.length <= want) { out.push(c); got += c.length; this.chunks.shift(); } else { out.push(c.subarray(0, want)); this.chunks[0] = c.subarray(want); got += want; }
    }
    this.bytes -= got;
    if (this.paused && this.bytes < LOW_WATER && this.stream) { this.paused = false; this.stream.resume(); }
    return got ? Buffer.concat(out, got) : Buffer.alloc(0);
  }

  clear() {
    this.chunks = []; this.bytes = 0; this.ready = false;
    if (this.paused && this.stream) { this.paused = false; this.stream.resume(); }
  }
}

// ---- AirPlay's metadata pipe -----------------------------------------------------------------

/**
 * shairport-sync writes items like
 *   <item><type>636f7265</type><code>6d696e6d</code><length>5</length>
 *   <data encoding="base64">SGVsbG8=</data></item>
 * (type and code are 4-letter words in hex). Feed it text; it calls back with { type, code, data }.
 */
export function airplayMetaParser(onItem) {
  let buf = '';
  const word = (hex) => Buffer.from(hex, 'hex').toString('latin1');
  return (text) => {
    buf += text;
    let end;
    while ((end = buf.indexOf('</item>')) >= 0) {
      const item = buf.slice(0, end);
      buf = buf.slice(end + 7);
      const type = /<type>([0-9a-f]{8})<\/type>/i.exec(item);
      const code = /<code>([0-9a-f]{8})<\/code>/i.exec(item);
      if (!type || !code) continue;
      const d = /<data encoding="base64">\s*([A-Za-z0-9+/=\s]*)<\/data>/.exec(item);
      onItem({ type: word(type[1]), code: word(code[1]), data: d ? Buffer.from(d[1].replace(/\s+/g, ''), 'base64') : null });
    }
    if (buf.length > 4_000_000) buf = ''; // a broken stream: start over rather than grow forever
  };
}

/** go-librespot's /status, read defensively: { playing, title, artist, album, art }. */
export function spotifyStatus(j) {
  const t = j && typeof j === 'object' ? j.track || null : null;
  if (!t) return { playing: false, title: '', artist: '', album: '', art: '' };
  const artists = Array.isArray(t.artist_names) ? t.artist_names.join(', ') : String(t.artist_names || t.artist || '');
  return {
    playing: !j.paused && !j.stopped,
    title: String(t.name || ''),
    artist: artists,
    album: String(t.album_name || ''),
    art: /^https:\/\//.test(String(t.album_cover_url || '')) ? String(t.album_cover_url) : ''
  };
}

/** The config go-librespot reads (YAML; strings are JSON-quoted, which YAML accepts). */
export function spotifyConfig({ name, pipe, apiPort }) {
  return [
    `device_name: ${JSON.stringify(name)}`,
    'device_type: speaker',
    'credentials:',
    '  type: zeroconf',
    'zeroconf_enabled: true',
    'audio_backend: pipe',
    `audio_output_pipe: ${JSON.stringify(pipe)}`,
    'audio_output_pipe_format: s16le',
    'bitrate: 320',
    'server:',
    '  enabled: true',
    '  address: 127.0.0.1',
    `  port: ${Number(apiPort)}`,
    ''
  ].join('\n');
}

/** shairport-sync's command line: raw audio on stdout, song details on a pipe. */
export function airplayArgs({ name, metaPipe, port = 5050 }) {
  return ['-a', name, '-o', 'stdout', '-p', String(port), '-M', '-g', `--metadata-pipename=${metaPipe}`];
}

// ---- the music service ---------------------------------------------------------------------

export function createMusic({ file, dataDir, log = console.log, now = () => Date.now(), spawnImpl = spawn, fetchImpl = (...a) => fetch(...a), find = findProgram, apiPort = 3679, airplayPort = 5050, platform = process.platform }) {
  let settings = readMusicSettings(file);
  const workDir = path.join(dataDir, 'music');
  const addonsDir = path.join(dataDir, 'addons');
  const sources = { spotify: new PcmSource('spotify', now), airplay: new PcmSource('airplay', now) };
  const procs = {};          // id -> { child, restarts, timer, problem, lastErr }
  const meta = {
    spotify: { title: '', artist: '', album: '', art: '', playing: false },
    airplay: { title: '', artist: '', album: '', art: '', playing: false, picture: null, pictureType: 'image/jpeg' }
  };
  const fds = [];
  const clients = new Set();
  const recent = [];          // the last second of MP3, for TVs that just joined
  let encoder = null;
  let clock = null;
  let startedAt = 0, produced = 0;
  let active = null;          // which source is playing now
  let pollTimer = null;
  let restartTimer = null;
  let stopped = true;
  const supported = platform === 'darwin' || platform === 'linux';

  const say = (m) => log(`[Music] ${m}`);

  function mkfifo(p) {
    try { if (fs.statSync(p).isFIFO()) return true; fs.unlinkSync(p); } catch (e) { /* not there yet */ }
    const r = spawnSync('mkfifo', [p]);
    return r.status === 0;
  }

  /** Reads a FIFO without ever blocking the server, and without ending when the writer goes away. */
  function openFifo(p) {
    const fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    fds.push(fd);
    return new net.Socket({ fd, readable: true, writable: false });
  }

  function program(id) {
    return find(SOURCES[id].program, { addonsDir });
  }

  function launch(id) {
    if (stopped || !settings.enabled || !settings[id]) return;
    const bin = program(id);
    const p = procs[id] || (procs[id] = { restarts: 0, problem: null, lastErr: '' });
    if (!bin) { p.problem = 'not installed'; return; }
    let child;
    try {
      fs.mkdirSync(workDir, { recursive: true });
      if (id === 'spotify') {
        const dir = path.join(workDir, 'spotify');
        fs.mkdirSync(dir, { recursive: true });
        const pipe = path.join(workDir, 'spotify.pcm');
        if (!mkfifo(pipe)) throw new Error("couldn't make the audio pipe");
        if (!p.reader) { p.reader = openFifo(pipe); sources.spotify.attach(p.reader); }
        fs.writeFileSync(path.join(dir, 'config.yml'), spotifyConfig({ name: settings.name, pipe, apiPort }));
        child = spawnImpl(bin, ['-config_dir', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      } else {
        const metaPipe = path.join(workDir, 'airplay.meta');
        if (!mkfifo(metaPipe)) throw new Error("couldn't make the song-details pipe");
        if (!p.metaReader) {
          p.metaReader = openFifo(metaPipe);
          p.metaReader.setEncoding('latin1');
          p.metaReader.on('data', airplayMetaParser(onAirplayItem));
        }
        child = spawnImpl(bin, airplayArgs({ name: settings.name, metaPipe, port: airplayPort }), { stdio: ['ignore', 'pipe', 'pipe'] });
        sources.airplay.attach(child.stdout);
      }
    } catch (e) {
      p.problem = e.message;
      say(`${SOURCES[id].name} didn't start: ${e.message}`);
      return retry(id);
    }
    p.child = child;
    p.problem = null;
    p.startedAt = now();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (t) => { p.lastErr = (p.lastErr + t).split('\n').slice(-6).join('\n').slice(-800); });
    child.on('error', (e) => { p.problem = e.message; });
    child.on('exit', (code, signal) => {
      // an older copy finishing after a restart: not news
      if (p.child !== child) return;
      p.child = null;
      if (stopped || !settings.enabled || !settings[id]) return;
      const last = (p.lastErr || '').trim().split('\n').pop() || '';
      p.problem = `stopped (${signal || `code ${code}`})${last ? `: ${last}` : ''}`;
      say(`${SOURCES[id].name} ${p.problem}`);
      // ran a good while: a normal hiccup; otherwise it keeps failing, so wait longer each time
      if (now() - p.startedAt > 120000) p.restarts = 0;
      retry(id);
    });
    say(`${SOURCES[id].name} is on, as "${settings.name}".`);
  }

  function retry(id) {
    const p = procs[id];
    if (!p || stopped) return;
    clearTimeout(p.timer);
    const wait = [5, 15, 60, 300][Math.min(p.restarts, 3)] * 1000;
    p.restarts++;
    p.timer = setTimeout(() => launch(id), wait);
    p.timer.unref?.();
  }

  function onAirplayItem({ type, code, data }) {
    const m = meta.airplay;
    const text = () => (data ? data.toString('utf8') : '');
    if (type === 'core') {
      if (code === 'minm') m.title = text();
      else if (code === 'asar') m.artist = text();
      else if (code === 'asal') m.album = text();
    } else if (type === 'ssnc') {
      if (code === 'PICT') {
        if (data && data.length > 100) {
          m.picture = data;
          m.pictureType = data[0] === 0x89 ? 'image/png' : 'image/jpeg';
          m.art = `/api/music/art?v=${now().toString(36)}`;
        } else { m.picture = null; m.art = ''; }
      } else if (code === 'pbeg' || code === 'prsm') m.playing = true;
      else if (code === 'pend' || code === 'pfls' || code === 'paus') m.playing = false;
      if (code === 'pend') { m.title = m.artist = m.album = m.art = ''; m.picture = null; }
    }
  }

  async function pollSpotify() {
    if (!procs.spotify?.child) { Object.assign(meta.spotify, { playing: false }); return; }
    try {
      const r = await fetchImpl(`http://127.0.0.1:${apiPort}/status`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 204) { Object.assign(meta.spotify, { playing: false, title: '', artist: '', album: '', art: '' }); return; }
      if (r.ok) Object.assign(meta.spotify, spotifyStatus(await r.json()));
    } catch (e) { /* starting up, or busy: try again next time */ }
  }

  // ---- mixing and encoding: one clock for everyone ----------------------------------------

  /** Which source plays: the one that started most recently and is still going. */
  function pick() {
    const t = now();
    const going = Object.values(sources).filter(s => s.playing(t));
    if (!going.length) return null;
    going.sort((a, b) => b.startedAt - a.startedAt);
    return going[0];
  }

  function tick() {
    const t = now();
    const due = Math.floor((t - startedAt) * RATE / 1000);
    let frames = Math.floor((due - produced) / FRAME);
    if (frames > 25) { produced = due - FRAME; frames = 1; } // the computer slept or stalled: don't race to catch up
    for (let i = 0; i < frames; i++) {
      const src = pick();
      if (src !== active) {
        // switching from one phone to another: the old one's leftovers would play late, so drop them
        if (active && src) active.clear();
        active = src;
      }
      let pcm = null;
      if (src && src.ready) {
        pcm = src.take(FRAME_BYTES);
        if (pcm.length < FRAME_BYTES) {
          // ran dry mid-song: pad this frame with silence and build up a little again
          pcm = Buffer.concat([pcm, Buffer.alloc(FRAME_BYTES - pcm.length)]);
          src.ready = src.bytes >= START_BUFFER;
        }
      }
      // sources nobody picked still drain, so a phone playing to us never stalls
      for (const s of Object.values(sources)) if (s !== src && s.bytes > HIGH_WATER * 0.9) s.take(FRAME_BYTES);
      produced += FRAME;
      if (clients.size) emit(encode(pcm));
    }
    if (!clients.size && !pick()) idle();
  }

  const L = new Int16Array(FRAME), R = new Int16Array(FRAME);
  function encode(pcm) {
    if (!encoder) encoder = new Mp3Encoder(2, RATE, settings.kbps);
    if (pcm) {
      for (let i = 0, o = 0; i < FRAME; i++, o += 4) { L[i] = pcm.readInt16LE(o); R[i] = pcm.readInt16LE(o + 2); }
    } else { L.fill(0); R.fill(0); }
    return Buffer.from(encoder.encodeBuffer(L, R));
  }

  function emit(mp3) {
    if (!mp3.length) return;
    recent.push(mp3);
    if (recent.length > PREBUFFER_FRAMES) recent.shift();
    for (const res of clients) {
      // a TV that can't keep up (it's off or the Wi-Fi dropped) is let go instead of piling up memory
      if (res.writableLength > 512 * 1024) { res.destroy(); clients.delete(res); continue; }
      res.write(mp3);
    }
  }

  function wake() {
    if (clock) return;
    startedAt = now(); produced = 0;
    clock = setInterval(tick, 40);
  }
  function idle() {
    clearInterval(clock); clock = null;
    encoder = null; recent.length = 0; active = null;
  }

  // a source starting to play wakes the clock, so audio keeps draining even with no TV on
  for (const s of Object.values(sources)) s.on('audio', () => { if (!clock && !stopped) wake(); });

  function stopChildren() {
    for (const p of Object.values(procs)) {
      clearTimeout(p.timer);
      if (p.child) { try { p.child.kill('SIGTERM'); } catch (e) {} p.child = null; }
    }
  }
  // never leave a speaker running after the server itself is gone
  process.once('exit', stopChildren);

  return {
    get settings() { return settings; },
    supported,

    start() {
      if (!supported) return;
      stopped = false;
      if (!settings.enabled) return;
      launch('spotify');
      launch('airplay');
      clearInterval(pollTimer);
      pollTimer = setInterval(pollSpotify, 2000);
      pollTimer.unref?.();
    },

    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      clearInterval(pollTimer);
      stopChildren();
      for (const res of clients) res.end();
      clients.clear();
      idle();
    },

    /** New settings from the setup page: saved, and the speakers restarted to match. */
    apply(next) {
      settings = saveMusicSettings(file, { ...settings, ...next });
      this.stop();
      for (const p of Object.values(procs)) p.restarts = 0;
      // a moment for the old speakers to let go of their network ports
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => this.start(), 1500);
      restartTimer.unref?.();
      return settings;
    },

    /** For the setup page. */
    status() {
      const out = {};
      for (const id of Object.keys(SOURCES)) {
        const p = procs[id] || {};
        out[id] = {
          wanted: settings.enabled && settings[id],
          installed: Boolean(program(id)),
          running: Boolean(p.child),
          problem: p.problem || null,
          playing: sources[id].playing()
        };
      }
      return { supported, enabled: settings.enabled, name: settings.name, listeners: clients.size, sources: out };
    },

    /** What the TVs need: null when music is off. */
    summary() {
      if (!supported || !settings.enabled) return null;
      const src = pick();
      const id = src ? src.id : meta.spotify.playing ? 'spotify' : meta.airplay.playing ? 'airplay' : null;
      const m = id ? meta[id] : null;
      return {
        name: settings.name,
        playing: Boolean(src),
        source: id,
        sourceName: id ? SOURCES[id].name : '',
        title: m?.title || '',
        artist: m?.artist || '',
        album: m?.album || '',
        art: m?.art || '',
        canControl: id === 'spotify',
        stream: '/api/music/stream.mp3'
      };
    },

    /** GET /api/music/stream.mp3: an endless MP3 stream. */
    stream(req, res) {
      if (!supported || !settings.enabled) return res.status(404).json({ error: 'Music is off on this server.' });
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'icy-name': settings.name
      });
      res.socket?.setNoDelay?.(true);
      for (const f of recent) res.write(f);
      clients.add(res);
      wake();
      const bye = () => clients.delete(res);
      req.on('close', bye);
      res.on('error', bye);
    },

    /** GET /api/music/art: AirPlay's cover picture (Spotify's covers are plain web addresses). */
    art(req, res) {
      const m = meta.airplay;
      if (!m.picture) return res.status(404).end();
      res.set('Cache-Control', 'max-age=3600').type(m.pictureType).send(m.picture);
    },

    /** POST /api/music/control { action: playpause | next | prev }: Spotify only. */
    async control(action) {
      const paths = { playpause: '/player/playpause', next: '/player/next', prev: '/player/prev' };
      if (!paths[action]) throw new Error('Unknown action.');
      const src = pick();
      const id = src ? src.id : meta.spotify.title ? 'spotify' : null;
      if (id !== 'spotify' || !procs.spotify?.child) throw new Error('Use the phone that is playing to control the music.');
      const r = await fetchImpl(`http://127.0.0.1:${apiPort}${paths[action]}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      if (!r.ok && r.status !== 204) throw new Error(`Spotify answered ${r.status}.`);
      setTimeout(pollSpotify, 400);
      return true;
    },

    // for tests
    _sources: sources,
    _tick: tick,
    _clients: clients,
    _meta: meta,
    _procs: procs,
    _airplayItem: onAirplayItem
  };
}
