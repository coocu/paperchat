import { ECDH } from 'node:crypto';
import { generateVAPIDKeys, sendNotification } from 'web-push';
import { textVault } from './vault.mjs';
import { reject } from './providers.mjs';

// Only browser vendors' push gateways may be contacted. Never fetch an arbitrary
// URL supplied by a member (including redirects, local addresses or credentials).
export function webSubscription(value) {
  try {
    if(!value || typeof value!=='object' || Array.isArray(value))throw Error();
    if(typeof value.endpoint!=='string' || value.endpoint.length>4096 || /[\s\u0000-\u001f\u007f]/.test(value.endpoint))throw Error();
    const url=new URL(value.endpoint),host=url.hostname;
    const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)
      || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(host);
    if(!allowed || url.protocol!=='https:' || url.port || url.username || url.password || url.hash || url.pathname==='/')throw Error();
    const key=(name,length)=>{
      const raw=value.keys?.[name];
      if(typeof raw!=='string' || !/^[A-Za-z0-9_-]+$/.test(raw))throw Error();
      const bytes=Buffer.from(raw,'base64url');
      if(bytes.length!==length || bytes.toString('base64url')!==raw)throw Error();
      return bytes;
    };
    const p256dh=key('p256dh',65),auth=key('auth',16);
    ECDH.convertKey(p256dh,'prime256v1');
    return {endpoint:url.href,keys:{p256dh:p256dh.toString('base64url'),auth:auth.toString('base64url')}};
  }catch {reject(400,'브라우저 알림 정보를 확인해 주세요.');}
}

export function webPushProvider(db,secret,send=sendNotification) {
  const name='web-push-vapid-v1',vault=textVault(secret,'paperchat/web-push/v1');
  const saved=db.prepare('SELECT value FROM service_meta WHERE key=?').get(name);
  let keys;
  if(saved)keys=JSON.parse(vault.open(Buffer.from(saved.value,'base64'),name));
  else {
    keys=generateVAPIDKeys();
    db.prepare('INSERT INTO service_meta VALUES(?,?)').run(name,vault.seal(JSON.stringify(keys),name).toString('base64'));
  }
  return {
    publicKey:keys.publicKey,
    enabled:platform=>platform==='web',
    async send(job,event,valid) {
      let subscription;
      try{subscription=webSubscription(JSON.parse(job.token));}catch{return 'invalid';}
      if(!valid())return 'skip';
      try {
        // No names, message text, photos, account IDs or login credentials.
        await send(subscription,JSON.stringify({kind:'chat',event,device:job.device,message:Number(job.message)}),{
          vapidDetails:{...keys,subject:'mailto:code_note95@naver.com'},TTL:120,urgency:'high',timeout:9000
        });
        return 'sent';
      }catch(e) {
        if([404,410].includes(e.statusCode))return 'invalid';
        // Do not expose subscription endpoints, encryption keys or responses.
        throw new Error('WebPush '+(Number.isInteger(e.statusCode)?e.statusCode:'connection'));
      }
    }
  };
}
