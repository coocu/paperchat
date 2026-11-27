import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { makeServer } from '../server.mjs';
import { openStore,clean,hour,tables } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { pushQueue } from '../push-queue.mjs';
import { policyVersion } from '../public/rules.js';

const day=24*hour,photo=Buffer.from([255,216,11,12,13,255,217]);
const reason='괴롭힘·기타 위반',area='경기도 이천시';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-admin-withdrawal-'));
  const actualNow=Date.now;let now=Date.UTC(2026,10,26,0,0,0);Date.now=()=>now;
  const origin='https://paperchat.example';
  const delivered=[],lookups=[];
  const pushProvider={enabled:()=>true,async send(job,event,valid){if(valid())delivered.push(job.message);return 'sent';}};
  const cfg={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider};
  const upstream={async check(code){lookups.push(code);return {status:'approved',token:'test'};}};
  let server=makeServer(cfg,upstream),serverClosed=false;
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
    now:()=>now,advance(ms){now+=ms;},restart(){if(!serverClosed)server.emit('close');server=makeServer(cfg,upstream);serverClosed=false;server.on('close',()=>serverClosed=true);}};
}

const remove=(admin,id,confirm=true)=>admin('/api/admin/members/'+id+'/delete',{confirm});
const one=(f,sql,...args)=>f.db.prepare(sql).get(...args);
const all=(f,sql,...args)=>f.db.prepare(sql).all(...args);
const linked=(f,id)=>all(f,'SELECT device FROM account_devices WHERE member=?',id).map(r=>r.device);

test('관리자 탈퇴는 본인·상대 방 데이터 전체를 지우고 별도 관리자와 다른 회원의 데이터는 보존한다',async t=>{
  const f=fixture(t),a=await f.register('탈퇴 대상'),b=await f.register('상대'),c=await f.register('다른 회원'),admin=await f.admin();
  const second=f.client(),pending=f.client();
  for(const call of [second,pending])assert.equal((await call('/api/account/login',{code:a.code})).status,200);
  const devices=linked(f,a.id);assert.equal(devices.length,3);
  await pending('/api/logout',{});await pending('/api/key',{code:'pending-signup'});
  await pending('/api/profile-details',{nick:'폐기할 입력',birthDate:'1995-01-03',gender:'여성'});
  // The administrator's independent installation has its own unrelated grant.
  await admin('/api/key',{code:'admin-own-signup'});
  const adminGrant=all(f,'SELECT * FROM signup_gates').find(g=>!devices.includes(g.device));assert.ok(adminGrant);
  const ab=await f.room(a,b),bc=await f.room(b,c);
  const aText=await f.send(a,ab,{body:'탈퇴 대상 원문'}),bText=await f.send(b,ab,{body:'상대 원문도 같은 방에서 삭제'});
  const aPhoto=await f.send(a,ab,{photo:photo.toString('base64')}),bPhoto=await f.send(b,ab,{photo:photo.toString('base64')});
  const keep=await f.send(b,bc,{body:'독립 방 보존'});
  await b.call('/api/report',{kind:'conversation',room:ab,reason});
  const session=one(f,"SELECT id FROM sessions WHERE member=? AND kind='member'",a.id).id;
  f.queue.bind(session,'android','android-target-device-123456789012345');
  f.queue.enqueue(bText);
  f.db.prepare('INSERT INTO contacts(member,encrypted,consented,verified,joined) VALUES(?,?,?,?,?)').run(a.id,Buffer.from('private-contact'),f.now(),f.now(),f.now());
  f.db.prepare('INSERT INTO pending_contacts(session,challenge,consented,encrypted) VALUES(?,?,?,?)').run(session,'challenge',f.now(),Buffer.from('pending-contact'));
  const eventsA=f.events(a.call),eventsB=f.events(b.call),eventsC=f.events(c.call);
  const version=(one(f,'SELECT version FROM room_changes WHERE room=?',ab)?.version||0)+1;
  assert.equal((await remove(f.client(),a.id)).status,401);
  assert.equal((await remove(b.call,a.id)).status,401);
  assert.equal((await remove(admin,a.id,false)).status,400);
  assert.equal((await remove(admin,a.id)).status,200);
  assert.equal(one(f,'SELECT 1 FROM members WHERE id=?',a.id),undefined);
  for(const id of [aText,bText,aPhoto,bPhoto])assert.equal(one(f,'SELECT 1 FROM messages WHERE id=?',id),undefined);
  assert.equal(one(f,'SELECT body FROM messages WHERE id=?',keep).body,'독립 방 보존');
  for(const table of ['account_keys','account_devices','contacts','acceptances','room_reads','member_activity'])
    assert.equal(one(f,'SELECT COUNT(*) AS n FROM '+table+' WHERE member=?',a.id).n,0);
  for(const table of ['reports','report_messages','pending_contacts','push_devices','push_jobs'])
    assert.equal(one(f,'SELECT COUNT(*) AS n FROM '+table).n,0);
  for(const call of [a.call,second,pending])assert.equal((await call('/api/state')).body.stage,'gate');
  assert.equal((await a.call('/api/account/login',{code:a.code})).status,403);
  assert.equal((await admin('/api/admin/rooms/'+ab+'/messages')).status,404);
  assert.equal((await admin('/api/admin/rooms?member='+a.id)).status,404);
  assert.equal((await admin('/api/admin/photos/'+aPhoto)).status,404);
  assert.deepEqual((await b.call('/api/rooms')).body.map(r=>r.id),[bc]);
  assert.equal(eventsA.writableEnded,true);
  assert.deepEqual(eventsB.events(),[{room:ab,closed:true,reason:'withdrawn',version,closedAt:f.now()}]);
  assert.deepEqual(eventsC.events(),[]);
  assert.equal((await admin('/api/admin/settings')).status,200);
  assert.equal(one(f,'SELECT 1 FROM cooldowns WHERE identity=?',adminGrant.device),undefined);
  assert.deepEqual(one(f,'SELECT * FROM signup_gates WHERE device=?',adminGrant.device),adminGrant);
  const departure=one(f,'SELECT * FROM departures WHERE id=?',a.id);
  assert.deepEqual({...departure},{id:a.id,nick:'탈퇴 대상',withdrawn:f.now(),expires:f.now()+day});
  assert.deepEqual((await admin('/api/admin/members/'+a.id)).body,{nick:'탈퇴 대상',withdrawn:f.now(),expires:f.now()+day,status:'withdrawn'});
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

for(const mode of ['self','admin'])test(`${mode} 탈퇴는 같은 기기 가입 입력·늦은 키 응답을 취소하고 제재 종료까지 재가입을 막는다`,async t=>{
  const f=fixture(t),a=await f.register('제재 대상'),admin=await f.admin(),pending=f.client(),late=f.client();
  for(const call of [pending,late])await call('/api/account/login',{code:a.code});
  const devices=linked(f,a.id),identity=one(f,'SELECT identity FROM members WHERE id=?',a.id).identity;
  const credential=one(f,'SELECT proof FROM account_keys WHERE member=?',a.id).proof;
  await pending('/api/logout',{});await pending('/api/key',{code:'approved-before-withdrawal'});
  await pending('/api/profile-details',{nick:'가입 중 원문',birthDate:'1995-01-03',gender:'여성'});
  await late('/api/logout',{});
  const check=f.upstream.check;let release,started;const ready=new Promise(resolve=>started=resolve);
  f.upstream.check=code=>code==='slow-approval'?new Promise(resolve=>{release=resolve;started();}):check(code);
  const inFlight=late('/api/key',{code:'slow-approval'});await ready;
  const until=f.now()+2*day;f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(identity,until);
  f.db.prepare('INSERT INTO penalty_events VALUES(?,?,?)').run('prior-penalty',identity,f.now());
  const response=mode==='self'?await a.call('/api/withdraw',{confirm:true}):await remove(admin,a.id);
  assert.equal(response.status,200);
  release({status:'approved',token:'late'});assert.equal((await inFlight).status,409);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM signup_gates').n,0);
  assert.equal((await pending('/api/register',{area,memo:'늦은 가입',policy:policyVersion})).status,401);
  for(const key of new Set([identity,credential,...devices])){
    assert.equal(one(f,'SELECT until FROM cooldowns WHERE identity=?',key).until,f.now()+day);
    assert.equal(one(f,'SELECT until FROM restrictions WHERE identity=?',key).until,until);
  }
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM penalty_events WHERE identity=?',identity).n,1);
  f.advance(day);clean(f.db,f.now());
  for(const call of [a.call,pending,late])assert.equal((await call('/api/key',{code:'still-approved'})).status,403);
  assert.equal((await a.call('/api/account/login',{code:a.code})).status,403);
  f.advance(day);clean(f.db,f.now());
  for(const call of [a.call,pending,late])assert.equal((await call('/api/key',{code:'still-approved'})).status,200);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM members').n,0);
});

test('관리자 재요청은 최초 탈퇴·쿨다운 기한을 늘리지 않으며 정확한 24시간 경계에서 목록이 사라진다',async t=>{
  const f=fixture(t),a=await f.register('24시간 대상'),admin=await f.admin(),devices=linked(f,a.id),start=f.now();
  await remove(admin,a.id);f.advance(hour);
  assert.equal((await remove(admin,a.id)).status,200);
  assert.equal(one(f,'SELECT withdrawn FROM departures WHERE id=?',a.id).withdrawn,start);
  for(const key of devices)assert.equal(one(f,'SELECT until FROM cooldowns WHERE identity=?',key).until,start+day);
  f.advance(day-hour-1);await f.admin(admin);
  assert.equal((await a.call('/api/key',{code:'reusable-key'})).status,403);
  assert.equal((await admin('/api/admin/members/'+a.id)).body.status,'withdrawn');
  assert.equal((await remove(admin,a.id)).status,200);
  f.advance(1);clean(f.db,f.now());
  assert.equal((await admin('/api/admin/members/'+a.id)).status,404);
  assert.equal((await remove(admin,a.id)).status,404);
  assert.equal((await a.call('/api/key',{code:'reusable-key'})).status,200);
  assert.equal((await admin('/api/admin/members')).body.counts.withdrawn,0);
  assert.equal(one(f,'SELECT 1 FROM departures WHERE id=?',a.id),undefined);
});

test('이전 tombstone은 최초 삭제 시각으로 전환하고 유실된 기기는 추정하지 않으며 재시작해도 기한을 늘리지 않는다',async t=>{
  const f=fixture(t),recent=await f.register('23시간 전 삭제'),old=await f.register('25시간 전 삭제'),keep=await f.register('유지 회원'),admin=await f.admin();
  const recentRoom=await f.room(recent,keep),oldRoom=await f.room(old,keep);
  await f.send(recent,recentRoom,{body:'구형 삭제 원문'});await f.send(keep,oldRoom,{body:'구형 상대 원문'});
  const recentDevices=linked(f,recent.id),lostDevices=linked(f,old.id),start=f.now();
  const recentIdentity=one(f,'SELECT identity FROM members WHERE id=?',recent.id).identity;
  f.db.prepare('UPDATE members SET deleted_at=? WHERE id=?').run(start-23*hour,recent.id);
  f.db.prepare('UPDATE members SET deleted_at=? WHERE id=?').run(start-25*hour,old.id);
  f.db.prepare('DELETE FROM account_keys WHERE member IN (?,?)').run(recent.id,old.id);
  f.db.prepare('DELETE FROM account_devices WHERE member=?').run(old.id);
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(recentIdentity,start+2*day);
  f.restart();
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM members').n,1);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM messages').n,0);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM rooms').n,0);
  const departed=one(f,'SELECT * FROM departures WHERE id=?',recent.id);
  assert.equal(departed.withdrawn,start-23*hour);assert.equal(departed.expires,start+hour);
  assert.equal(one(f,'SELECT 1 FROM departures WHERE id=?',old.id),undefined);
  for(const device of recentDevices){
    assert.equal(one(f,'SELECT until FROM cooldowns WHERE identity=?',device).until,start+hour);
    assert.equal(one(f,'SELECT until FROM restrictions WHERE identity=?',device).until,start+2*day);
  }
  for(const device of lostDevices)assert.equal(one(f,'SELECT 1 FROM cooldowns WHERE identity=?',device),undefined);
  assert.equal((await recent.call('/api/state')).body.stage,'gate');assert.equal((await old.call('/api/state')).body.stage,'gate');
  assert.equal((await keep.call('/api/state')).body.profile.id,keep.id);
  f.advance(hour/2);f.restart();assert.deepEqual(one(f,'SELECT * FROM departures WHERE id=?',recent.id),departed);
  f.advance(hour/2);f.restart();assert.equal(one(f,'SELECT COUNT(*) AS n FROM departures').n,0);
  assert.equal((await admin('/api/admin/members/'+recent.id)).status,404);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM account_keys').n,1);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('삭제 중 DB 오류는 데이터·가입 예약·SSE를 모두 롤백하고 성공한 재시도만 반영한다',async t=>{
  const f=fixture(t),a=await f.register('롤백 대상'),b=await f.register('상대'),admin=await f.admin(),pending=f.client(),room=await f.room(a,b);
  await pending('/api/account/login',{code:a.code});await pending('/api/logout',{});await pending('/api/key',{code:'pending'});
  const message=await f.send(a,room,{photo:photo.toString('base64')});await b.call('/api/report',{kind:'conversation',room,reason});
  const eventsA=f.events(a.call),eventsB=f.events(b.call);
  const names=['members','rooms','messages','reports','report_messages','sessions','signup_gates','account_devices','account_keys','cooldowns','restrictions','departures'];
  const snapshot=()=>Object.fromEntries(names.map(name=>[name,all(f,'SELECT * FROM '+name+' ORDER BY rowid')]));
  const before=snapshot();
  f.db.exec(`CREATE TRIGGER fail_withdrawal BEFORE DELETE ON members WHEN OLD.id='${a.id}' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`);
  assert.equal((await remove(admin,a.id)).status,500);
  assert.deepEqual(snapshot(),before);assert.deepEqual(eventsB.events(),[]);assert.equal(eventsA.writableEnded,false);
  assert.ok(one(f,'SELECT photo FROM messages WHERE id=?',message).photo);
  f.db.exec('DROP TRIGGER fail_withdrawal');
  assert.equal((await remove(admin,a.id)).status,200);
  assert.equal(eventsA.writableEnded,true);assert.equal(eventsB.events().length,1);
  assert.equal(one(f,'SELECT 1 FROM messages WHERE id=?',message),undefined);
  assert.equal(one(f,'SELECT COUNT(*) AS n FROM signup_gates').n,0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

