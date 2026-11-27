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
  const dir=mkdtempSync(join(tmpdir(),'paperchat-conversation-report-'));
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

const reportRoom=(member,room)=>member.call('/api/report',{kind:'conversation',room,reason});
const reportMessage=(member,message)=>member.call('/api/report',{kind:'message',message,reason});
const decide=(admin,id,action)=>admin('/api/admin/review',{kind:'report',id,action});
const queue=async admin=>(await admin('/api/admin/review')).body.reports;
const photograph=(f,member,room)=>f.send(member,room,{photo:photo.toString('base64')});
const messages=async(member,room)=>(await member.call('/api/rooms/'+room+'/messages')).body;
const photoStatus=async(member,id)=>(await member.call('/api/photos/'+id)).status;

test('방 참가자만 상대의 현재 사진을 고정 신고하며 본인·다른 방·새 사진은 숨기지 않는다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),c=await f.register('다른 회원'),admin=await f.admin();
  const room=await f.room(a,b),elsewhere=await f.room(a,c);
  const expired=await photograph(f,a,room);f.advance(24*hour+1);
  const first=await photograph(f,a,room),second=await photograph(f,a,room),own=await photograph(f,b,room);
  const other=await photograph(f,a,elsewhere),deleted=await photograph(f,a,room),removed=await photograph(f,a,room);
  await a.call('/api/messages/'+deleted+'/delete',{confirm:true});
  f.db.prepare("UPDATE reviews SET state='removed' WHERE message=?").run(removed);
  f.db.prepare('UPDATE messages SET photo=NULL WHERE id=?').run(removed);
  const text=await f.send(a,room,{body:'신고 당시 상대의 마지막 대화'});
  assert.equal((await f.client()('/api/report',{kind:'conversation',room,reason})).status,401);
  assert.equal((await reportRoom(c,room)).status,404);
  assert.equal((await reportRoom(b,randomUUID())).status,404);
  assert.equal((await reportRoom(b,42)).status,400);
  assert.equal((await b.call('/api/report',{kind:'conversation',room,reason:'잘못된 사유'})).status,400);
  const eventsA=f.events(a.call),eventsB=f.events(b.call),eventsC=f.events(c.call);
  await f.admin(admin);
  assert.equal((await reportRoom(b,room)).status,200);
  const [group]=await queue(admin);
  assert.equal(group.conversationRoom,room);assert.equal(group.sender,a.id);assert.equal(group.reporter,b.id);
  assert.equal(group.photoCount,2);assert.equal(group.excerpt,'신고 당시 상대의 마지막 대화');
  assert.deepEqual(group.photos.map(p=>p.id),[first,second]);
  assert.ok(group.photos.every(p=>p.viewable===1 && p.deletedAt===null && p.expires===f.now()+24*hour));
  const version=f.db.prepare('SELECT version FROM room_changes WHERE room=?').get(room).version;
  await reportRoom(b,room);assert.equal((await queue(admin)).length,1);
  assert.equal(f.db.prepare('SELECT version FROM room_changes WHERE room=?').get(room).version,version);
  for(const stream of [eventsA,eventsB])assert.deepEqual(stream.events(),[{room,refresh:true,version}]);
  assert.deepEqual(eventsC.events(),[]);
  for(const member of [a,b]){
    const shown=await messages(member,room);
    for(const id of [first,second]){
      assert.equal(shown.find(m=>m.id===id).visibility,'reported');assert.equal(await photoStatus(member,id),403);
    }
    assert.equal(shown.find(m=>m.id===text).body,'신고 당시 상대의 마지막 대화');
    assert.equal(await photoStatus(member,own),200);
    assert.equal(shown.find(m=>m.id===deleted).visibility,'deleted');
    assert.equal(shown.some(m=>m.id===expired),false);
  }
  assert.equal((await b.call('/api/unread')).body.total,1);
  assert.equal((await b.call('/api/rooms/'+room+'/read',{through:first})).status,400);
  assert.equal((await admin('/api/admin/photos/'+first)).status,200);
  assert.equal(await photoStatus(c,other),200);
  const later=await photograph(f,a,room);
  assert.equal(await photoStatus(b,later),200);assert.equal((await queue(admin))[0].photoCount,2);
  assert.equal((await decide(admin,group.id,'dismiss')).status,200);
  assert.equal(await photoStatus(b,first),200);
  assert.equal(eventsB.events().at(-1).version,version+1);
  assert.equal((await a.call('/api/rooms/'+room+'/leave',{confirm:true})).status,200);
  assert.equal((await reportRoom(b,room)).status,404);
});

test('그룹과 개별 신고가 겹치면 마지막 열린 신고가 끝날 때까지 사진을 숨긴다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),admin=await f.admin(),room=await f.room(a,b);
  const first=await photograph(f,a,room),second=await photograph(f,a,room);
  await reportMessage(b,first);await reportRoom(b,room);
  const reports=await queue(admin),single=reports.find(r=>r.message===first),group=reports.find(r=>r.conversationRoom===room);
  await decide(admin,group.id,'dismiss');
  assert.equal(await photoStatus(b,first),403);assert.equal(await photoStatus(b,second),200);
  await decide(admin,single.id,'dismiss');assert.equal(await photoStatus(b,first),200);
  const third=await photograph(f,a,room);await reportRoom(b,room);
  const secondGroup=(await queue(admin))[0];await reportMessage(b,third);
  const newSingle=(await queue(admin)).find(r=>r.message===third);
  await decide(admin,newSingle.id,'dismiss');assert.equal(await photoStatus(b,third),403);
  await decide(admin,secondGroup.id,'dismiss');assert.equal(await photoStatus(b,third),200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,0);
});

test('거부해도 삭제·만료·이용규칙 삭제된 사진을 복원하거나 만료를 연장하지 않는다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),admin=await f.admin(),room=await f.room(a,b);
  const expires=await photograph(f,a,room);f.advance(hour);
  const deleted=await photograph(f,a,room),removed=await photograph(f,a,room),live=await photograph(f,a,room);
  await reportRoom(b,room);const group=(await queue(admin))[0];
  await a.call('/api/messages/'+deleted+'/delete',{confirm:true});
  await reportMessage(b,removed);const single=(await queue(admin)).find(r=>r.message===removed);
  await decide(admin,single.id,'accept');
  f.advance(23*hour+1);clean(f.db,f.now());
  await f.admin(admin);
  const pending=(await queue(admin))[0];assert.equal(pending.photoCount,4);
  assert.deepEqual(pending.photos.map(p=>[p.id,p.viewable]),[[deleted,1],[removed,0],[live,1]]);
  await decide(admin,group.id,'dismiss');
  const shown=await messages(b,room);
  assert.equal(shown.some(m=>m.id===expires),false);
  assert.equal(shown.find(m=>m.id===deleted).visibility,'deleted');
  assert.equal(shown.find(m=>m.id===removed).visibility,'removed');
  assert.equal(await photoStatus(b,live),200);
  assert.equal((await admin('/api/admin/photos/'+expires)).status,404);
  assert.equal((await admin('/api/admin/photos/'+removed)).status,410);
  assert.equal(f.db.prepare('SELECT 1 FROM messages WHERE id=?').get(expires),undefined);
  assert.equal(f.db.prepare('SELECT expires FROM messages WHERE id=?').get(live).expires,group.photos.find(p=>p.id===live).expires);
  f.advance(hour);clean(f.db,f.now());assert.equal((await admin('/api/admin/photos/'+deleted)).status,404);
});

test('여러 사진의 그룹 승인은 1회이고 중복 개별·그룹 승인에는 같은 사진 벌점을 다시 주지 않는다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),c=await f.register('다른 회원'),admin=await f.admin(),room=await f.room(a,b),otherRoom=await f.room(a,c);
  const own=await photograph(f,b,room),other=await photograph(f,a,otherRoom);
  const first=await photograph(f,a,room),second=await photograph(f,a,room);
  await reportMessage(b,first);await reportRoom(b,room);
  const initial=await queue(admin),single=initial.find(r=>r.message===first),group=initial.find(r=>r.conversationRoom===room);
  const third=await photograph(f,a,room);await reportRoom(b,room);
  const overlap=(await queue(admin)).find(r=>r.id!==group.id && r.conversationRoom===room);
  await decide(admin,group.id,'accept');
  let penalty=(await admin('/api/admin/members/'+a.id)).body;assert.equal(penalty.totalStrikes,1);
  await decide(admin,single.id,'accept');assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,1);
  await decide(admin,group.id,'accept');assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,1);
  assert.equal(await photoStatus(b,third),403);
  await decide(admin,overlap.id,'accept');assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,2);
  await reportRoom(b,room);assert.equal((await queue(admin)).length,0);
  for(const id of [first,second,third]){
    assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(id).photo,null);
    assert.equal((await admin('/api/admin/photos/'+id)).status,410);
  }
  assert.equal(await photoStatus(a,own),200);assert.equal(await photoStatus(c,other),200);
  const fourth=await photograph(f,a,room);await reportMessage(b,fourth);await reportRoom(b,room);
  const last=await queue(admin),singleLast=last.find(r=>r.message===fourth),groupLast=last.find(r=>r.conversationRoom===room);
  // An individual approval first covers the group completely, yielding only 1 strike.
  await decide(admin,singleLast.id,'accept');await decide(admin,groupLast.id,'accept');
  penalty=(await admin('/api/admin/members/'+a.id)).body;
  assert.equal(penalty.totalStrikes,3);assert.equal(penalty.strikes,0);assert.equal(penalty.restrictedUntil,f.now()+24*hour);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,3);
});

test('사진 없는 대화도 신고할 수 있고 같은 기록 재신고는 멱등이며 프로필은 삭제하지 않는다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),admin=await f.admin(),room=await f.room(a,b);
  await reportRoom(b,room);let group=(await queue(admin))[0];
  assert.equal(group.photoCount,0);assert.deepEqual(group.photos,[]);assert.equal(group.excerpt,null);
  assert.equal((await decide(admin,group.id,'accept')).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,0);
  await decide(admin,group.id,'dismiss');await reportRoom(b,room);assert.equal((await queue(admin)).length,0);
  const text=await f.send(a,room,{body:'사진 없이도 신고할 수 있는 대화'});
  await reportRoom(b,room);group=(await queue(admin))[0];
  assert.equal(group.photoCount,0);assert.equal(group.excerpt,'사진 없이도 신고할 수 있는 대화');
  const later=await f.send(a,room,{body:'신고 후 보낸 새 대화'});
  await decide(admin,group.id,'accept');
  assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,1);
  assert.equal((await a.call('/api/state')).body.profile.nick,'상대');
  const shown=await messages(b,room);
  assert.equal(shown.find(m=>m.id===text).body,null);assert.equal(shown.find(m=>m.id===text).visibility,'removed');
  assert.equal(shown.find(m=>m.id===later).body,'신고 후 보낸 새 대화');
  assert.equal(f.db.prepare('SELECT body FROM messages WHERE id=?').get(text).body,null);
  assert.equal(f.db.prepare('SELECT conversation_excerpt FROM reports WHERE id=?').get(group.id).conversation_excerpt,null);
  await reportMessage(b,text);const single=(await queue(admin))[0];await decide(admin,single.id,'accept');
  assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,1);
  await reportRoom(b,room);await reportRoom(b,room);
  const next=await queue(admin);assert.equal(next.length,1);assert.equal(next[0].excerpt,'신고 후 보낸 새 대화');
});

test('스냅샷·숨김·중복 벌점 연결은 재시작 후 보존되고 방 삭제와 초기화에 FK가 남지 않는다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),admin=await f.admin(),room=await f.room(a,b);
  const first=await photograph(f,a,room),second=await photograph(f,a,room);
  await reportRoom(b,room);const group=(await queue(admin))[0];
  f.restart();assert.equal(await photoStatus(b,first),403);assert.deepEqual((await queue(admin))[0].photos,group.photos);
  await decide(admin,group.id,'accept');f.restart();
  await reportMessage(b,second);const single=(await queue(admin))[0];await decide(admin,single.id,'accept');
  assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,1);
  const count=f.db.prepare('SELECT COUNT(*) AS n FROM penalty_contents').get().n;assert.ok(count>=2);
  f.db.prepare('DELETE FROM rooms WHERE id=?').run(room);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM report_messages').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_contents').get().n,count);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await admin('/api/admin/reset',{confirm:'전체 삭제',key:'codenote-test-kyh'})).status,200);
  for(const name of ['report_messages','reports','penalty_contents','penalty_events'])assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+name).get().n,0);
});

test('그룹 신고 뒤 대기 중 푸시와 웹 알림 재확인을 모두 차단한다',async t=>{
  const f=fixture(t),a=await f.register('상대'),b=await f.register('신고자'),room=await f.room(a,b);
  const session=f.db.prepare("SELECT id FROM sessions WHERE member=? AND kind='member'").get(b.id).id;
  f.queue.bind(session,'android','android-conversation-token-123456789');
  const web=randomUUID();f.db.prepare('INSERT INTO push_devices VALUES(?,?,?,?)').run(web,session,'web','{}');
  const hidden=await photograph(f,a,room);await reportRoom(b,room);
  const visible=await photograph(f,a,room);
  assert.equal(f.queue.mayNotify(session,web,hidden),false);assert.equal(f.queue.mayNotify(session,web,visible),true);
  f.queue.enqueue(hidden);f.queue.enqueue(visible);await f.queue.flush();
  assert.ok(!f.delivered.includes(hidden));assert.ok(f.delivered.includes(visible));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,0);
});

