import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeServer } from '../server.mjs';
import { clean, hour, openStore } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { pushQueue } from '../push-queue.mjs';
import { webPushProvider, webSubscription } from '../web-push.mjs';
import { policyVersion } from '../public/rules.js';

const photo=Buffer.from([255,216,11,12,13,255,217]).toString('base64');
function subscription(endpoint='https://fcm.googleapis.com/fcm/send/'+randomUUID()) {
  return {endpoint,keys:{p256dh:createECDH('prime256v1').generateKeys().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-web-push-'));
  let now=Date.UTC(2026,10,27,0,0,0),sendFailure;
  t.mock.method(Date,'now',()=>now);
  // Drive the real queue explicitly, without the server's periodic runner racing it.
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const db=openStore(dir),safety=moderation(db),secret=randomBytes(40).toString('hex');
  const attempts=[],delivered=[];
  const provider=webPushProvider(db,secret,async(sub,payload,options)=>{
    attempts.push({sub,payload:JSON.parse(payload),options});
    if(sendFailure)throw sendFailure;
    delivered.push(JSON.parse(payload));
  });
  const origin='https://paperchat.example';
  const server=makeServer({dir,origin,secret,webPushProvider:provider,
    pushProvider:{enabled:()=>true,async send(){throw Error('Unexpected native delivery');}}},
  {async check(){return {status:'approved',token:'approved-for-test'};}});
  const queue=pushQueue(db,provider,safety);
  t.after(()=>{queue.close();server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    const call=async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin??origin,'user-agent':'test-browser',
        cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(k){return headers[k.toLowerCase()];},setHeader(k,v){headers[k.toLowerCase()]=v;},
          writeHead(status,h){this.status=status;for(const [k,v]of Object.entries(h||{}))this.setHeader(k,v);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(e){reject(e);}
      });
    };
    call.cookies=cookies;return call;
  }
  async function member(nick) {
    const call=client();
    assert.equal((await call('/api/key',{code:'test-'+randomUUID()})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area:'서울 동부',memo:'소개글',policy:policyVersion})).status,200);
    const {profile}=(await call('/api/state')).body,{code}=(await call('/api/account/recovery')).body;
    const session=db.prepare("SELECT id FROM sessions WHERE member=? AND kind='member'").get(profile.id).id;
    return {call,id:profile.id,code,session};
  }
  async function bind(member,sub=subscription()) {
    const response=await member.call('/api/push/web',{subscription:sub});
    assert.equal(response.status,200);assert.equal(response.body.configured,true);
    const device=db.prepare("SELECT * FROM push_devices WHERE session=? AND platform='web'").get(member.session);
    return {...device,sub};
  }
  async function room(a,b) {
    const response=await a.call('/api/room',{peer:b.id});assert.equal(response.status,200);return response.body.id;
  }
  async function send(a,room,body={body:'개인 대화 원문'}) {
    assert.equal((await a.call('/api/rooms/'+room+'/messages',body)).status,200);
    return db.prepare('SELECT MAX(id) AS id FROM messages WHERE room=?').get(room).id;
  }
  async function check(call,device,message) {
    const response=await call('/api/push/web/check?device='+encodeURIComponent(device)+'&message='+message);
    assert.equal(response.status,200);return response.body.notify;
  }
  return {db,safety,provider,queue,client,member,bind,room,send,check,attempts,delivered,
    now:()=>now,advance(ms){now+=ms;},fail(error){sendFailure=error;}};
}

test('Web Push subscriptions accept vendor HTTPS gateways and valid browser keys only',()=>{
  const sub=subscription();
  for(const host of ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns2-db5p.notify.windows.com']) {
    const value={...sub,endpoint:'https://'+host+'/push/id',expirationTime:null,extra:'discard'};
    assert.deepEqual(webSubscription(value),{endpoint:value.endpoint,keys:sub.keys});
  }
  assert.equal(webSubscription({...sub,endpoint:'https://FCM.GOOGLEAPIS.COM/push/id'}).endpoint,'https://fcm.googleapis.com/push/id');
  for(const endpoint of ['http://fcm.googleapis.com/push/id','https://127.0.0.1/push/id','https://[::1]/push/id',
    'https://localhost/push/id','https://fcm.googleapis.com.attacker.example/push/id','https://attacker.example/push/id',
    'https://notify.windows.com.attacker.example/push/id','https://user:secret@fcm.googleapis.com/push/id',
    'https://fcm.googleapis.com:8443/push/id','https://fcm.googleapis.com/push/id#secret','https://fcm.googleapis.com/',
    'https://fcm.googleapis.com/push/ id','https://fcm.googleapis.com/push/\nsecret','https://fcm.googleapis.com/'+ 'x'.repeat(4096)])
    assert.throws(()=>webSubscription({...sub,endpoint}),e=>e.status===400,endpoint);
  for(const value of [null,[],{}, {...sub,keys:{}}, {...sub,keys:{...sub.keys,auth:sub.keys.auth+'='}},
    {...sub,keys:{...sub.keys,auth:randomBytes(15).toString('base64url')}},
    {...sub,keys:{...sub.keys,p256dh:Buffer.alloc(65).toString('base64url')}}])
    assert.throws(()=>webSubscription(value),e=>e.status===400);
});

test('VAPID survives a database restart, stays sealed and never enters the notification payload',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'paperchat-vapid-')),secret=randomBytes(40).toString('hex');
  let db=openStore(dir),captured;
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const provider=webPushProvider(db,secret,async(...args)=>{captured=args;});
  const sub=subscription(),job={token:JSON.stringify(sub),device:randomUUID(),message:17,
    body:'PRIVATE_MESSAGE_TEXT',photo:'PRIVATE_PHOTO',nick:'PRIVATE_NICK',member:'PRIVATE_ACCOUNT',session:'PRIVATE_LOGIN'};
  assert.deepEqual(Object.keys(provider).sort(),['enabled','publicKey','send']);
  assert.equal(Buffer.from(provider.publicKey,'base64url').length,65);
  assert.equal(provider.enabled('web'),true);assert.equal(provider.enabled('android'),false);
  assert.equal(await provider.send(job,'event-id',()=>true),'sent');
  assert.deepEqual(captured[0],sub);
  assert.deepEqual(JSON.parse(captured[1]),{kind:'chat',event:'event-id',device:job.device,message:17});
  assert.doesNotMatch(captured[1],/PRIVATE_|privateKey|token/);
  const options=captured[2];
  assert.equal(options.TTL,120);assert.equal(options.timeout,9000);assert.equal(options.urgency,'high');
  assert.equal(options.vapidDetails.publicKey,provider.publicKey);
  assert.equal(options.vapidDetails.subject,'mailto:code_note95@naver.com');
  const saved=db.prepare("SELECT value FROM service_meta WHERE key='web-push-vapid-v1'").get().value;
  assert.ok(!saved.includes(options.vapidDetails.privateKey));
  assert.ok(!Buffer.from(saved,'base64').includes(Buffer.from(options.vapidDetails.privateKey)));
  const publicKey=provider.publicKey;
  db.close();db=openStore(dir);
  assert.equal(webPushProvider(db,secret).publicKey,publicKey);
  assert.equal(db.prepare("SELECT value FROM service_meta WHERE key='web-push-vapid-v1'").get().value,saved);
  assert.throws(()=>webPushProvider(db,randomBytes(40).toString('hex')));
});

test('provider skips invalidated sends, removes expired subscriptions and sanitizes retry errors',async t=>{
  const f=fixture(t),job={token:JSON.stringify(subscription()),device:randomUUID(),message:1};
  assert.equal(await f.provider.send({...job,token:'invalid json'},'e',()=>true),'invalid');
  assert.equal(await f.provider.send({...job,token:JSON.stringify(subscription('https://localhost/private'))},'e',()=>true),'invalid');
  assert.equal(await f.provider.send(job,'e',()=>false),'skip');assert.equal(f.attempts.length,0);
  for(const statusCode of [404,410]) {
    f.fail(Object.assign(Error('private endpoint and response'),{statusCode}));
    assert.equal(await f.provider.send(job,'e',()=>true),'invalid');
  }
  for(const statusCode of [429,503]) {
    f.fail(Object.assign(Error('private endpoint and response'),{statusCode}));
    await assert.rejects(f.provider.send(job,'e',()=>true),{message:'WebPush '+statusCode});
  }
  f.fail(Error('https://private-subscription.example/credential'));
  await assert.rejects(f.provider.send(job,'e',()=>true),{message:'WebPush connection'});
});

test('web registration requires a current member and same-origin POST; public config exposes only the public key',async t=>{
  const f=fixture(t),anonymous=f.client(),a=await f.member('권한 검증'),sub=subscription();
  const config=await anonymous('/api/push/web-config');
  assert.equal(config.status,200);assert.deepEqual(config.body,{publicKey:f.provider.publicKey});
  assert.match(config.headers['cache-control'],/no-store/);
  assert.equal((await anonymous('/api/push/web',{subscription:sub})).status,401);
  assert.equal((await a.call('/api/push/web',{subscription:sub},{origin:'https://attacker.example'})).status,403);
  assert.equal((await a.call('/api/push/web',{subscription:sub},{origin:''})).status,403);
  const changed=await a.call('/api/push/web',{subscription:sub},{headers:{'x-paperchat-member':randomUUID()}});
  assert.equal(changed.status,409);assert.equal(changed.body.code,'ACCOUNT_CHANGED');
  assert.equal((await a.call('/api/push/device',{platform:'web',token:JSON.stringify(sub)})).status,400);
  assert.equal((await a.call('/api/push/web',{subscription:{...sub,endpoint:'https://localhost/internal'}})).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_devices').get().n,0);
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(a.id);
  assert.equal((await a.call('/api/push/web',{subscription:sub})).status,403);
  f.safety.accept(a.id,policyVersion);
  const identity=f.db.prepare('SELECT identity FROM members WHERE id=?').get(a.id).identity;
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(identity,f.now()+hour);
  assert.equal((await a.call('/api/push/web',{subscription:sub})).status,403);
});

test('canonical subscription rebinding is idempotent, rotates endpoint keys and isolates accounts and native devices',async t=>{
  const f=fixture(t),a=await f.member('보내는 회원'),b=await f.member('받는 회원'),c=await f.member('다른 회원');
  const room=await f.room(a,b),device=await f.bind(b),message=await f.send(a,room);
  const jobs=()=>f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n;
  assert.equal(jobs(),1);
  const reordered={expirationTime:null,keys:{auth:device.sub.keys.auth,p256dh:device.sub.keys.p256dh},endpoint:device.sub.endpoint};
  assert.equal((await f.bind(b,reordered)).id,device.id);assert.equal(jobs(),1);
  const rotated=await f.bind(b,subscription(device.sub.endpoint));
  assert.notEqual(rotated.id,device.id);assert.equal(jobs(),0);
  assert.equal(await f.check(b.call,device.id,message),false);
  f.queue.enqueue(message);assert.equal(jobs(),1);
  const moved=await f.bind(c,rotated.sub);
  assert.notEqual(moved.id,rotated.id);assert.equal(jobs(),0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_devices WHERE platform='web'").get().n,1);
  assert.equal(await f.check(b.call,rotated.id,message),false);
  assert.equal(await f.check(c.call,moved.id,message),false);
  assert.equal((await c.call('/api/push/device',{platform:'android',token:'native-token-retained-123456789'})).status,200);
  assert.equal((await c.call('/api/push/web',{subscription:null})).status,200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_devices WHERE platform='web'").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM push_devices WHERE platform='android'").get().n,1);
});

test('only the receiving session can confirm an unread notification; reading and account switching invalidate late delivery',async t=>{
  const f=fixture(t),a=await f.member('발신'),b=await f.member('수신'),c=await f.member('계정 전환');
  const room=await f.room(a,b),device=await f.bind(b),message=await f.send(a,room);
  assert.equal(await f.check(b.call,device.id,message),true);
  for(const call of [f.client(),a.call,c.call])assert.equal(await f.check(call,device.id,message),false);
  for(const bad of ['0','-1','1.2','NaN','9007199254740992'])assert.equal(await f.check(b.call,device.id,bad),false);
  assert.equal(await f.check(b.call,'bad-device',message),false);
  f.queue.enqueue(message);await f.queue.flush();
  assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].message,message);
  const next=await f.send(a,room,{body:'읽은 뒤에는 알리지 않음'});
  assert.equal((await b.call('/api/rooms/'+room+'/read',{through:next})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);
  assert.equal(await f.check(b.call,device.id,next),false);
  await f.queue.flush();assert.equal(f.delivered.length,1);
  const delayed=await f.send(a,room);
  assert.equal(await f.check(b.call,device.id,delayed),true);
  assert.equal((await b.call('/api/account/login',{code:c.code})).status,200);
  assert.equal((await b.call('/api/state')).body.profile.id,c.id);
  assert.equal(await f.check(b.call,device.id,delayed),false);
  assert.equal(f.db.prepare('SELECT 1 FROM push_devices WHERE id=?').get(device.id),undefined);
  await f.queue.flush();assert.equal(f.delivered.length,1);
});

test('reports, author deletion, leaving and blocking suppress pending and already-in-flight web notifications',async t=>{
  const f=fixture(t),a=await f.member('신고 대상'),b=await f.member('신고 회원');
  const room=await f.room(a,b),device=await f.bind(b);
  let message=await f.send(a,room);
  assert.equal((await b.call('/api/report',{kind:'message',message,reason:'괴롭힘·기타 위반'})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);await f.queue.flush();assert.equal(f.delivered.length,0);
  const report=f.db.prepare('SELECT id FROM reports WHERE message=?').get(message).id;
  f.safety.reportDecision(report,'dismiss');assert.equal(await f.check(b.call,device.id,message),true);
  message=await f.send(a,room);
  assert.equal((await a.call('/api/messages/'+message+'/delete',{confirm:true})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);await f.queue.flush();assert.equal(f.delivered.length,0);
  message=await f.send(a,room);
  assert.equal((await b.call('/api/rooms/'+room+'/leave',{confirm:true})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);await f.queue.flush();assert.equal(f.delivered.length,0);
  await f.room(a,b);assert.equal(await f.check(b.call,device.id,message),false);
  message=await f.send(a,room);
  assert.equal((await b.call('/api/blocks',{peer:a.id})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);
  assert.equal((await b.call('/api/blocks',{peer:a.id,remove:true})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);
  await f.room(a,b);assert.equal(await f.check(b.call,device.id,message),false);
  await f.queue.flush();assert.equal(f.delivered.length,0);
});

test('photo confirmation stops exactly at original twelve-hour expiry, including notifications already sent',async t=>{
  const f=fixture(t),a=await f.member('사진 발신'),b=await f.member('사진 수신');
  const room=await f.room(a,b),device=await f.bind(b),message=await f.send(a,room,{photo});
  assert.equal(await f.check(b.call,device.id,message),true);await f.queue.flush();assert.equal(f.delivered.length,1);
  assert.deepEqual(Object.keys(f.delivered[0]).sort(),['device','event','kind','message']);
  f.advance(12*hour-1);assert.equal(await f.check(b.call,device.id,message),true);
  f.advance(1);assert.equal(await f.check(b.call,device.id,message),false);
  f.queue.enqueue(message);await f.queue.flush();assert.equal(f.delivered.length,1);
  clean(f.db,f.now());assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(message).photo,null);
});

test('expired sessions, policy changes, restrictions, logout and account removal suppress delayed notifications',async t=>{
  const f=fixture(t),a=await f.member('계정 상태 발신'),b=await f.member('계정 상태 수신');
  const room=await f.room(a,b),device=await f.bind(b),message=await f.send(a,room);
  const identity=f.db.prepare('SELECT identity FROM members WHERE id=?').get(a.id).identity;
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(identity,f.now()+hour);
  assert.equal(await f.check(b.call,device.id,message),false);
  f.db.prepare('DELETE FROM restrictions WHERE identity=?').run(identity);
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(b.id);
  assert.equal(await f.check(b.call,device.id,message),false);
  f.safety.accept(b.id,policyVersion);assert.equal(await f.check(b.call,device.id,message),true);
  const expiry=f.db.prepare('SELECT expires FROM sessions WHERE id=?').get(b.session).expires;
  f.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(f.now(),b.session);
  assert.equal(await f.check(b.call,device.id,message),false);
  f.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(expiry,b.session);
  assert.equal((await b.call('/api/logout',{})).status,200);
  assert.equal(await f.check(b.call,device.id,message),false);
  assert.equal(f.db.prepare('SELECT 1 FROM push_devices WHERE id=?').get(device.id),undefined);
  await f.queue.flush();assert.equal(f.delivered.length,0);
  const other=await f.member('관리자 삭제 수신'),otherRoom=await f.room(a,other),otherDevice=await f.bind(other);
  const otherMessage=await f.send(a,otherRoom),admin=f.client();
  assert.equal((await admin('/api/admin/login',{key:'codenote-test-kyh'})).status,200);
  assert.equal((await admin('/api/admin/members/'+other.id+'/delete',{confirm:true})).status,200);
  assert.equal(await f.check(other.call,otherDevice.id,otherMessage),false);
  assert.equal(f.db.prepare('SELECT 1 FROM push_devices WHERE id=?').get(otherDevice.id),undefined);
  await f.queue.flush();assert.equal(f.delivered.length,0);
});

test('web delivery retries transient failures without leaking endpoint details and drops expired subscriptions with their jobs',async t=>{
  const f=fixture(t),a=await f.member('재시도 발신'),b=await f.member('재시도 수신');
  const room=await f.room(a,b),device=await f.bind(b),message=await f.send(a,room),logs=[];
  t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
  f.fail(Object.assign(Error(device.sub.endpoint),{statusCode:503}));await f.queue.flush();
  const pending=f.db.prepare('SELECT * FROM push_jobs WHERE message=?').get(message);
  assert.equal(pending.tries,1);assert.equal(pending.due,f.now()+5000);assert.equal(f.delivered.length,0);
  assert.equal(logs.length,1);assert.ok(!logs[0].includes(device.sub.endpoint));assert.doesNotMatch(logs[0],/p256dh|auth/);
  f.advance(4999);await f.queue.flush();assert.equal(f.attempts.length,1);
  f.fail(null);f.advance(1);await f.queue.flush();assert.equal(f.delivered.length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,0);
  await f.send(a,room);await f.send(a,room);
  f.fail(Object.assign(Error('subscription gone'),{statusCode:410}));await f.queue.flush();
  assert.equal(f.db.prepare('SELECT 1 FROM push_devices WHERE id=?').get(device.id),undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,0);
  assert.equal(f.delivered.length,1);
});
