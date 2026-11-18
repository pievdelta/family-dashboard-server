// Lets the TV find this server by itself on the home network (SSDP, the same
// way Roku and smart TVs find each other). The TV asks "is a family dashboard
// here?" and the server answers with its address.
import dgram from 'dgram';
import { lanAddress } from './pairing.js';

export const SERVICE_TYPE = 'urn:loux-family:service:dashboard:1';
const GROUP = '239.255.255.250';
const SSDP_PORT = 1900;

export function startDiscovery({ port, householdId, version, log = console.log }) {
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    log(`[Discovery] Off: ${e.message}`);
    return null;
  }
  sock.on('error', (e) => {
    log(`[Discovery] Off (the TV will need the address typed in): ${e.message}`);
    try { sock.close(); } catch (_) {}
  });
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
    const st = (text.match(/^ST:\s*(.+)$/im) || [])[1]?.trim() || '';
    if (st !== SERVICE_TYPE && st !== 'ssdp:all') return;
    const base = lanAddress(port);
    const hid = typeof householdId === 'function' ? householdId() : householdId;
    const reply = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=120',
      'EXT:',
      `LOCATION: ${base}/api/dashboard`,
      `SERVER: FamilyDashboard/${typeof version === 'function' ? version() : version}`,
      `ST: ${SERVICE_TYPE}`,
      `USN: uuid:${hid || 'family-dashboard'}::${SERVICE_TYPE}`,
      '', ''
    ].join('\r\n');
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.bind(SSDP_PORT, () => {
    try {
      sock.addMembership(GROUP);
      log('[Discovery] TVs on this network can find the server by themselves.');
    } catch (e) {
      log(`[Discovery] Off (the TV will need the address typed in): ${e.message}`);
    }
  });
  return sock;
}
