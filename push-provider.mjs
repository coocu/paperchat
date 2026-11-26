import { pushSettings } from './push-config.mjs';
import { sign } from 'node:crypto';
import { connect } from 'node:http2';

const scope = 'https://www.googleapis.com/auth/firebase.messaging';
const oauth = 'https://oauth2.googleapis.com/token';
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

function jwt(header, claims, key, ecdsa = false) {
  const input = encode(header) + '.' + encode(claims);
  const signature = sign('sha256', Buffer.from(input), ecdsa ? {key, dsaEncoding:'ieee-p1363'} : key);
  return input + '.' + signature.toString('base64url');
}

async function appleRequest(host, headers, payload) {
  const client = connect('https://' + host);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => client.destroy(new Error('APNs timeout')), 9000);
      client.once('close', () => { clearTimeout(timeout); reject(new Error('APNs connection closed')); });
      client.once('error', reject);
      const request = client.request(headers);
      let status, body = '';
      request.setEncoding('utf8');
      request.on('response', h => { status = h[':status']; });
      request.on('data', c => { body += c; });
      request.once('error', reject);
      request.once('end', () => {
        clearTimeout(timeout);
        let reason;
        try { reason = JSON.parse(body).reason; } catch {}
        resolve({status, reason});
      });
      request.end(JSON.stringify(payload));
    });
  } finally { client.destroy(); }
}

export function pushProvider(env = process.env, http = fetch, apns = appleRequest) {
  const {google,android,apple,development,androidMismatch}=pushSettings(env);
  const appleFor = platform => platform === 'ios-dev' ? development : apple;
  const topic = env.APNS_BUNDLE_ID || 'com.codenote.paperchat';
  let access, renewal;

  async function refreshGoogle() {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt({alg:'RS256',typ:'JWT'}, {iss:google.client_email,scope,aud:oauth,iat:now,exp:now+3600}, google.key);
    const response = await http(oauth, {method:'POST',signal:AbortSignal.timeout(8000),
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    if (!response.ok) throw new Error('FCM OAuth ' + response.status);
    const data = await response.json();
    if (!data.access_token || !(data.expires_in > 0)) throw new Error('FCM OAuth response');
    return access = {value:data.access_token, expires:now + data.expires_in};
  }
  async function googleToken() {
    if (access?.expires > Date.now()/1000 + 60) return access.value;
    renewal ||= refreshGoogle().finally(() => { renewal = null; });
    return (await renewal).value;
  }
  function apnsToken(credentials) {
    const now = Math.floor(Date.now()/1000);
    if (!credentials.cached || now - credentials.cached.iat >= 2700) credentials.cached = {iat:now,
      value:jwt({alg:'ES256',kid:credentials.id},{iss:env.APNS_TEAM_ID,iat:now},credentials.key,true)};
    return credentials.cached.value;
  }
  return {
    androidClient: android,
    enabled: platform => platform === 'android' ? Boolean(google) && !androidMismatch : Boolean(appleFor(platform)),
    async send(device, event, valid) {
      if (device.platform === 'android') {
        const key = await googleToken();
        if (!valid()) return 'skip';
        const url = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(google.project_id) + '/messages:send';
        const response = await http(url, {method:'POST', signal:AbortSignal.timeout(9000),
          headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'}, body:JSON.stringify({message:{
            token:device.token, android:{priority:'high',ttl:'120s'}, data:{kind:'chat',event}
          }})});
        if (response.ok) return 'sent';
        if (response.status === 401) access = null;
        const data = await response.json().catch(()=>({}));
        if (data.error?.details?.some(d=>d.errorCode==='UNREGISTERED')) return 'invalid';
        throw new Error('FCM ' + response.status);
      }
      if (!valid()) return 'skip';
      const host = device.platform === 'ios-dev' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
      const reply = await apns(host,{':method':'POST',':path':'/3/device/'+device.token,
        authorization:'bearer '+apnsToken(appleFor(device.platform)),'apns-topic':topic,'apns-push-type':'alert','apns-priority':'10',
        'apns-expiration':String(Math.floor(Date.now()/1000)+120),'apns-collapse-id':event},
        {aps:{alert:{title:'종이편지',body:'새 메시지가 도착했어요.'},sound:'default'},kind:'chat'});
      if (reply.status === 200) return 'sent';
      if (reply.status === 410 && reply.reason === 'Unregistered') return 'invalid';
      throw new Error('APNs ' + reply.status + ' ' + (reply.reason || 'unknown'));
    }
  };
}
