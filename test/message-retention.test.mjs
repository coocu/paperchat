import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { makeServer } from '../server.mjs';
import { openStore,clean,hour,messageTTL,tables } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { pushQueue } from '../push-queue.mjs';
import { policyVersion } from '../public/rules.js';

const day=24*hour,photo=Buffer.from([255,216,11,12,13,255,217]);
const reason='괴롭힘·기타 위반',area='경기도 이천시';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-message-retention-'));
  const actualNow=Date.now;let now=Date.UTC(2026,10,26,0,0,0);Date.now=()=>now;
  const origin='https://paperchat.example';
  const delivered=[],lookups=[];
  const pushProvider={enabled:()=>true,async send(job,event,valid){if(valid())delivered.push(job.message);return 'sent';}};
  const cfg={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider};
  const upstream={async check(code){lookups.push(code);return {status:'approved',token:'test'};}};
  let maintenance;
  function start(){
    const original=setInterval;
    globalThis.setInterval=(fn,delay,...args)=>{if(delay===30000)maintenance=fn;return original(fn,delay,...args);};
    try{return makeServer(cfg,upstream);}finally{globalThis.setInterval=original;}
  }
  let server=start(),serverClosed=false;
  server.on('close',()=>serverClosed=true);
  const db=openStore(dir),queue=pushQueue(db,pushProvider,moderation(db));
  t.after(()=>{queue.close();if(!serverClosed)server.emit('close');db.close();Date.now=actualNow;rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    const call=async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:options.ip||randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin||origin,'user-agent':'test-browser',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')};
      return new Promise((done,reject)=>{
        const headers={};
        const res={status:200,getHeader(k){return headers[k.toLowerCase()];},setHeader(k,v){headers[k.toLowerCase()]=v;},
          writeHead(n,h){this.status=n;for(const [k,v] of Object.entries(h||{}))this.setHeader(k,v);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            done({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(e){reject(e);}
      });
    };
    call.cookies=cookies;return call;
  }
  async function register(nick,region=area,call=client(),invitation='invite-'+randomUUID()) {
    assert.equal((await call('/api/key',{code:invitation})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area:region,memo:'소개',policy:policyVersion})).status,200);
    const {profile}= (await call('/api/state')).body;
    const {code}=(await call('/api/account/recovery')).body;
    return {call,id:profile.id,code};
  }
  async function admin(call=client()){assert.equal((await call('/api/admin/login',{key:'codenote-test-kyh'})).status,200);return call;}
  async function room(a,b){const response=await a.call('/api/room',{peer:b.id});assert.equal(response.status,200);return response.body.id;}
  async function send(a,id,body){assert.equal((await a.call('/api/rooms/'+id+'/messages',body)).status,200);return db.prepare('SELECT MAX(id) AS id FROM messages WHERE room=?').get(id).id;}
  function events(call) {
    const req=Readable.from([]);req.method='GET';req.url='/api/events';req.socket={remoteAddress:'events'};
    req.headers={cookie:[...call.cookies].map(([k,v])=>k+'='+v).join('; ')};
    const res=new EventEmitter();res.chunks=[];res.headers={};res.writableEnded=false;
    res.setHeader=(k,v)=>res.headers[k.toLowerCase()]=v;res.getHeader=k=>res.headers[k.toLowerCase()];
    res.writeHead=(status,h)=>{res.status=status;res.headersSent=true;for(const[k,v]of Object.entries(h))res.setHeader(k,v);};
    res.write=data=>{res.chunks.push(data);return true;};res.end=data=>{if(data)res.chunks.push(data);res.writableEnded=true;res.emit('close');};
    server.emit('request',req,res);
    res.events=()=>res.chunks.filter(c=>c.startsWith('event: room-change')).map(c=>JSON.parse(c.split('data: ')[1]));
    return res;
  }
  return {db,queue,client,register,admin,room,send,events,delivered,upstream,lookups,server:()=>server,
    maintain:()=>maintenance(),now:()=>now,advance(ms){now+=ms;},restart(){if(!serverClosed)server.emit('close');server=start();serverClosed=false;server.on('close',()=>serverClosed=true);}};
}

const one=(f,sql,...args)=>f.db.prepare(sql).get(...args);
const all=(f,sql,...args)=>f.db.prepare(sql).all(...args);
const photoMessage=(f,a,room)=>f.send(a,room,{photo:photo.toString('base64')});
const report=(a,room)=>a.call('/api/report',{kind:'conversation',room,reason});
const queue=async admin=>(await admin('/api/admin/review')).body.reports;
const decide=(admin,id,action='accept')=>admin('/api/admin/review',{kind:'report',id,action});

test('글·사진은 전송24h 정확한 경계에서 cleaner 전에도 모든 회원·관리자 조회와 읽음·신고에서 제외된다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('수신자'),admin=await f.admin(),room=await f.room(a,b),sent=f.now();
  const probe='RETENTION_PRIVATE_TEXT_8eb0a5d9',text=await f.send(a,room,{body:probe}),picture=await photoMessage(f,a,room);
  const path='/api/rooms/'+room+'/messages',adminPath='/api/admin/rooms/'+room+'/messages';
  const initial=(await b.call(path)).body;
  assert.equal(initial.find(m=>m.id===text).expires,null);assert.equal(initial.find(m=>m.id===picture).expires,sent+messageTTL);
  assert.ok(initial.every(m=>m.expiresAt===sent+messageTTL));
  const streams=[f.events(a.call),f.events(b.call)];
  f.advance(messageTTL-1);await f.admin(admin);
  for(const [call,url]of [[b.call,path],[admin,adminPath]])assert.equal((await call(url)).body.length,2);
  assert.equal((await b.call('/api/photos/'+picture)).status,200);
  assert.equal((await b.call('/api/unread')).body.total,2);
  assert.equal((await admin('/api/admin/rooms?q='+probe)).body.length,1);
  f.advance(1);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM messages').n,2);
  for(const [call,url]of [[b.call,path],[admin,adminPath]])assert.deepEqual((await call(url)).body,[]);
  assert.equal((await b.call('/api/photos/'+picture)).status,410);assert.equal((await admin('/api/admin/photos/'+picture)).status,410);
  assert.equal((await b.call('/api/unread')).body.total,0);
  assert.equal((await b.call('/api/rooms/'+room+'/read',{through:text})).status,400);
  assert.equal((await b.call('/api/report',{kind:'message',message:text,reason})).status,404);
  assert.deepEqual((await admin('/api/admin/rooms?q='+probe)).body,[]);
  assert.deepEqual((await admin('/api/admin/monitor/profiles?q='+probe)).body,[]);
  assert.equal((await b.call('/api/rooms')).body[0].recent,null);
  assert.equal((await admin('/api/admin/rooms')).body[0].recent,null);
  assert.ok((await admin('/api/admin/monitor/profiles')).body.every(p=>p.recent===null));
  f.maintain();
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM messages').n,0);assert.equal(one(f,'SELECT COUNT(*) AS n FROM rooms').n,1);
  for(const stream of streams)assert.deepEqual(stream.events(),[{room,expired:true,previousVersion:0,refresh:true,version:1}]);
  assert.equal((await admin('/api/admin/photos/'+picture)).status,404);
  assert.deepEqual(clean(f.db,f.now()),[]);
  const file=all(f,'PRAGMA database_list').find(db=>db.name==='main').file;
  assert.equal(readFileSync(file).includes(Buffer.from(probe)),false);
});

test('본인삭제·신고·방나가기·차단을 해도 보관 시작시각은 바뀌지 않고 관리자 원문도24h에 지운다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('상대'),c=await f.register('다른 상대'),admin=await f.admin();
  const ab=await f.room(a,b),ac=await f.room(a,c),sent=f.now();
  const deleted=await f.send(a,ab,{body:'삭제한 원문'}),image=await photoMessage(f,a,ab);
  const blocked=await f.send(a,ac,{body:'차단된 방 원문'});
  f.advance(hour);await a.call('/api/messages/'+deleted+'/delete',{confirm:true});await report(b,ab);
  const group=(await queue(admin))[0];
  await b.call('/api/rooms/'+ab+'/leave',{confirm:true});await c.call('/api/blocks',{peer:a.id});
  assert.ok(all(f,'SELECT sent FROM messages').every(m=>m.sent===sent));
  assert.equal((await admin('/api/admin/rooms/'+ab+'/messages')).body.length,2);
  assert.equal((await admin('/api/admin/rooms/'+ac+'/messages')).body.length,1);
  assert.equal((await admin('/api/admin/photos/'+image)).status,200);
  f.advance(messageTTL-hour);await f.admin(admin);
  for(const room of [ab,ac])assert.deepEqual((await admin('/api/admin/rooms/'+room+'/messages')).body,[]);
  assert.equal((await decide(admin,group.id)).status,409);
  const expired=(await queue(admin))[0];assert.equal(expired.photoCount,1);assert.ok(expired.photos.every(p=>p.viewable===0));
  f.maintain();
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM messages').n,0);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM rooms').n,2);
  assert.equal(one(f,'SELECT 1 FROM messages WHERE id=?',blocked),undefined);
  assert.equal((await queue(admin))[0].photoCount,1);assert.deepEqual((await queue(admin))[0].photos,[]);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM penalty_events').n,0);
});

test('신고 검토 본문과 복사본은 각 원문의 만료시각을 따르며 만료된 증거로 승인할 수 없다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('신고자'),admin=await f.admin(),room=await f.room(a,b),sent=f.now();
  const probe='SNAPSHOT_PRIVATE_TEXT_76aedcb3',text=await f.send(a,room,{body:probe});
  await report(b,room);const textGroup=(await queue(admin))[0];
  await b.call('/api/report',{kind:'message',message:text,reason});
  const textSingle=(await queue(admin)).find(r=>r.message===text);
  assert.equal(textSingle.expiresAt,sent+messageTTL);assert.equal(textSingle.excerptExpiresAt,sent+messageTTL);
  assert.equal(textGroup.excerptExpiresAt,sent+messageTTL);
  f.advance(1000);const picture=await photoMessage(f,a,room);await report(b,room);
  await b.call('/api/report',{kind:'message',message:picture,reason});
  const photoGroup=(await queue(admin)).find(r=>r.conversationRoom && r.id!==textGroup.id);
  const photoSingle=(await queue(admin)).find(r=>r.message===picture);
  assert.equal(photoGroup.photoCount,1);assert.equal(photoGroup.photos[0].expires,sent+1000+messageTTL);
  assert.equal(photoSingle.expiresAt,sent+1000+messageTTL);
  f.advance(messageTTL-1000);await f.admin(admin);
  let pending=await queue(admin);
  assert.ok(!pending.some(r=>r.id===textSingle.id));
  assert.ok(pending.filter(r=>r.conversationRoom).every(r=>r.excerpt===null));
  assert.equal(pending.find(r=>r.id===photoGroup.id).photos[0].viewable,1);
  assert.equal((await decide(admin,textSingle.id)).status,409);
  assert.equal((await decide(admin,textGroup.id)).status,409);
  assert.ok(one(f,'SELECT conversation_excerpt FROM reports WHERE id=?',textGroup.id).conversation_excerpt);
  f.advance(1000);
  assert.equal((await decide(admin,photoGroup.id)).status,409);assert.equal((await decide(admin,photoSingle.id)).status,409);
  f.maintain();pending=await queue(admin);
  assert.equal(pending.length,2);assert.ok(pending.every(r=>r.excerpt===null && r.excerptExpiresAt===null && r.photos.length===0));
  assert.equal(pending.find(r=>r.id===photoGroup.id).photoCount,1);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM reports WHERE conversation_excerpt IS NOT NULL').n,0);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM penalty_events').n,0);
  const file=all(f,'PRAGMA database_list').find(db=>db.name==='main').file;
  assert.equal(readFileSync(file).includes(Buffer.from(probe)),false);
});

test('레거시 사진은 남은 원본만24h로 연장하고12h 만료·삭제본은 복원하지 않으며 오래된 글은 시작시 지운다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('수신자'),admin=await f.admin(),room=await f.room(a,b),now=f.now();
  const seed=(sent,expires,body,bytes)=>Number(f.db.prepare('INSERT INTO messages(room,author,sent,body,photo,expires) VALUES(?,?,?,?,?,?)').run(room,a.id,sent,body,bytes,expires).lastInsertRowid);
  const live=seed(now-10*hour,now+2*hour,null,photo),expired=seed(now-13*hour,now-hour,null,photo);
  const removed=seed(now-hour,now+11*hour,null,photo),purged=seed(now-hour,now+11*hour,null,null);
  const oldText=seed(now-messageTTL,null,'OLD_TEXT_MUST_DELETE',null),text=seed(now-messageTTL+1,null,'남은1ms',null);
  f.db.prepare("INSERT INTO reviews VALUES(?,'removed')").run(removed);
  f.db.exec('CREATE TABLE deleted_messages(message INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,body TEXT,photo BLOB,deleted_at INTEGER NOT NULL)');
  const archivedLive=seed(now-10*hour,now+2*hour,null,null),archivedExpired=seed(now-13*hour,now-hour,null,null);
  for(const id of [archivedLive,archivedExpired])f.db.prepare('INSERT INTO deleted_messages VALUES(?,NULL,?,?)').run(id,photo,now-hour);
  f.restart();
  for(const id of [live,archivedLive]){
    assert.equal(one(f,'SELECT expires FROM messages WHERE id=?',id).expires,now+14*hour);
    assert.ok(one(f,'SELECT photo FROM messages WHERE id=?',id).photo);
    assert.equal((await admin('/api/admin/photos/'+id)).status,200);
  }
  for(const id of [expired,removed,purged,archivedExpired]){
    assert.equal(one(f,'SELECT photo FROM messages WHERE id=?',id).photo,null);
    assert.equal((await admin('/api/admin/photos/'+id)).status,410);
  }
  assert.equal(one(f,'SELECT 1 FROM messages WHERE id=?',oldText),undefined);
  assert.equal(one(f,'SELECT body FROM messages WHERE id=?',text).body,'남은1ms');
  f.advance(1);f.restart();assert.equal(one(f,'SELECT 1 FROM messages WHERE id=?',text),undefined);
  assert.equal(one(f,'SELECT expires FROM messages WHERE id=?',live).expires,now+14*hour);
  assert.equal(one(f,"SELECT 1 FROM sqlite_master WHERE name='deleted_messages'"),undefined);
  for(const id of [expired,removed,purged,archivedExpired])assert.equal(one(f,'SELECT photo FROM messages WHERE id=?',id).photo,null);
});

test('Android·iOS·웹 푸시와 웹 재확인은 글·사진24h 만료 후 전달하지 않는다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('수신자'),room=await f.room(a,b);
  const session=one(f,"SELECT id FROM sessions WHERE member=? AND kind='member'",b.id).id;
  f.queue.bind(session,'android','android-retention-device-1234567890');
  f.queue.bind(session,'ios-dev','ab'.repeat(32));f.queue.bind(session,'ios-prod','cd'.repeat(32));
  const web=randomUUID();f.db.prepare('INSERT INTO push_devices VALUES(?,?,?,?)').run(web,session,'web','{}');
  const oldText=await f.send(a,room,{body:'만료 직전 글'}),oldPhoto=await photoMessage(f,a,room);
  f.advance(messageTTL-1);
  const fresh=await f.send(a,room,{body:'새 글은 전달'});
  for(const id of [oldText,oldPhoto]){
    assert.equal(f.queue.mayNotify(session,web,id),true);
    f.queue.enqueue(id);
  }
  // Keep old jobs in the due queue to exercise the content TTL guard, not job expiry.
  f.db.prepare('UPDATE push_jobs SET expires=?,due=?').run(f.now()+hour,f.now());
  f.advance(1);
  for(const id of [oldText,oldPhoto])assert.equal(f.queue.mayNotify(session,web,id),false);
  const count=one(f,'SELECT COUNT(*) AS n FROM push_jobs').n;f.queue.enqueue(oldText);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM push_jobs').n,count);
  await f.queue.flush();
  assert.ok(!f.delivered.includes(oldText));assert.ok(!f.delivered.includes(oldPhoto));
  assert.equal(f.delivered.filter(id=>id===fresh).length,4);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM push_jobs').n,0);
});

