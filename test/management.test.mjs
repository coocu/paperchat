import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { makeServer } from '../server.mjs';
import { openStore,clean,hour,tables } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { pushQueue } from '../push-queue.mjs';
import { policyVersion } from '../public/rules.js';

const day=24*hour,photo=Buffer.from([255,216,11,12,13,255,217]);
const reason='괴롭힘·기타 위반',area='경기도 이천시';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-management-'));
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

test('동일 인증키로 만든 회원은 복구·개인 대화·탈퇴 제한을 서로 공유하지 않는다',async t=>{
  const f=fixture(t),shared='shared-approved-key';
  const [a,b,c]=await Promise.all(['공유키 하나','공유키 둘','공유키 셋'].map(nick=>f.register(nick,area,f.client(),shared)));
  assert.equal(new Set([a.id,b.id,c.id]).size,3);assert.equal(new Set([a.code,b.code,c.code]).size,3);
  assert.equal(new Set(f.db.prepare('SELECT identity FROM members').all().map(m=>m.identity)).size,3);
  const ab=await f.room(a,b),message=await f.send(a,ab,{body:'둘만의 편지'});
  assert.equal((await c.call('/api/rooms/'+ab+'/messages')).status,404);
  assert.deepEqual((await c.call('/api/rooms')).body,[]);
  assert.equal((await b.call('/api/rooms/'+ab+'/messages')).body[0].id,message);
  const another=f.client();await another('/api/account/login',{code:b.code});
  assert.equal((await another('/api/state')).body.profile.id,b.id);
  assert.equal((await f.client()('/api/account/login',{code:shared})).status,403);
  await a.call('/api/withdraw',{confirm:true});
  assert.equal((await a.call('/api/key',{code:shared})).status,403);
  const later=await f.register('다음 공유키 회원',area,f.client(),shared);
  assert.ok(![a.id,b.id,c.id].includes(later.id));
  assert.equal((await b.call('/api/state')).body.profile.id,b.id);
  assert.equal((await c.call('/api/state')).body.profile.id,c.id);
});

test('가입 승인은 기기별로 교체·복구·만료되고 모든 키 입력에서 외부 승인을 확인한다',async t=>{
  const f=fixture(t),user=f.client();
  assert.equal((await user('/api/key',{code:'first-key'})).status,200);
  const original=f.db.prepare('SELECT * FROM signup_gates').get();
  await user('/api/profile-details',{nick:'진행 중',birthDate:'1995-01-03',gender:'여성'});
  const old=f.client();for(const [k,v]of user.cookies)old.cookies.set(k,v);
  assert.equal((await user('/api/key',{code:'different-key'})).status,200);
  const replacement=f.db.prepare('SELECT * FROM signup_gates').get();
  assert.equal(replacement.device,original.device);assert.notEqual(replacement.proof,original.proof);
  assert.equal((await old('/api/profile-details',{nick:'옛 요청',birthDate:'1995-01-03',gender:'여성'})).status,401);
  assert.equal((await user('/api/state')).body.stage,'gate_ok');
  await user('/api/profile-details',{nick:'새 입력',birthDate:'1995-01-03',gender:'여성'});
  const check=f.upstream.check;
  for(const answer of [{status:'pending',token:'pending'},{status:'expired',token:'expired'},{status:'approved',token:'  '}]) {
    let calls=0;f.upstream.check=async()=>{calls++;return answer;};
    assert.equal((await user('/api/key',{code:'different-key'})).status,403);assert.equal(calls,1);
    assert.equal((await user('/api/state')).body.stage,'details');
    assert.deepEqual(f.db.prepare('SELECT * FROM signup_gates').get(),replacement);
  }
  f.upstream.check=check;
  user.cookies.delete('pc_user');
  assert.equal((await user('/api/state')).body.stage,'gate_ok');
  assert.deepEqual(f.db.prepare('SELECT * FROM signup_gates').get(),replacement);
  f.restart();assert.equal((await user('/api/state')).body.stage,'gate_ok');
  f.advance(replacement.expires-f.now());
  assert.equal((await user('/api/state')).body.stage,'gate');
  assert.equal((await user('/api/profile-details',{nick:'만료',birthDate:'1995-01-03',gender:'여성'})).status,401);
  clean(f.db,f.now());assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM signup_gates').get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind IN ('gate_ok','details')").get().n,0);
  assert.equal((await user('/api/key',{code:'first-key'})).status,200);
});

test('늦은 키 승인 응답은 같은 기기의 새 인증·가입·복구로그인·로그아웃을 덮지 않는다',async t=>{
  const f=fixture(t),existing=await f.register('복구할 회원');
  const check=f.upstream.check;
  for(const action of ['replace','register','login','logout']) {
    const user=f.client();await user('/api/key',{code:'initial-'+action});
    await user('/api/profile-details',{nick:'경합 '+action,birthDate:'1995-01-03',gender:'여성'});
    let started,release;const ready=new Promise(resolve=>started=resolve);
    f.upstream.check=async code=>code==='delayed-'+action?new Promise(resolve=>{release=resolve;started();}):check(code);
    const pending=user('/api/key',{code:'delayed-'+action});await ready;
    let member=null;
    if(action==='replace')assert.equal((await user('/api/key',{code:'latest-key'})).status,200);
    if(action==='register'){
      assert.equal((await user('/api/register',{area,memo:'경합 검증',policy:policyVersion})).status,200);
      member=(await user('/api/state')).body.profile.id;
    }
    if(action==='login'){
      assert.equal((await user('/api/account/login',{code:existing.code})).status,200);member=existing.id;
    }
    if(action==='logout')assert.equal((await user('/api/logout',{})).status,200);
    const cookie=user.cookies.get('pc_user');
    release({status:'approved',token:'late'});
    const response=await pending;assert.equal(response.status,409);assert.equal(response.headers['set-cookie'],undefined);
    assert.equal(user.cookies.get('pc_user'),cookie);
    const state=(await user('/api/state')).body;
    assert.equal(state.stage,member?'member':'gate_ok');if(member)assert.equal(state.profile.id,member);
    f.upstream.check=check;
  }
});

test('프로필 편집은 본인 지역·소개글만 검증해 저장하고 모든 조회에 반영한다',async t=>{
  const f=fixture(t),a=await f.register('편집 회원'),b=await f.register('상대 회원','인천광역시 검단구'),admin=await f.admin();
  const room=await f.room(a,b),message=await f.send(a,room,{body:'기존 대화 보존'});
  const before=(await a.call('/api/state')).body.profile,peerBefore=(await b.call('/api/state')).body.profile;
  assert.equal(before.area,'경기 남부');
  assert.equal((await f.client()('/api/profile',{area:'서울 동부',memo:'안녕'})).status,401);
  assert.equal((await admin('/api/profile',{area:'서울 동부',memo:'안녕'})).status,401);
  const registering=f.client();await registering('/api/key',{code:'profile-test-pending-key'});
  assert.equal((await registering('/api/profile',{area:'서울 동부',memo:'안녕'})).status,401);
  assert.equal((await a.call('/api/profile',{area:'서울 동부',memo:'안녕'},{origin:'https://untrusted.example'})).status,403);
  for(const [key,value] of Object.entries({nick:'다른 이름',year:2010,birthDate:'2010-01-01',gender:'남성',id:b.id,identity:'changed',unknown:true,policy:policyVersion}))
    assert.equal((await a.call('/api/profile',{area:'서울 동부',memo:'적용하면 안 됨',[key]:value})).status,400);
  for(const body of [{},{memo:'글'},{area:'서울 동부'},...['',null,123,'가'.repeat(801)].map(memo=>({area:'서울 동부',memo})),
    ...['',null,[],{},'서울 전체','아무 지역','지역 미선택'].map(area=>({area,memo:'소개'}))])
    assert.equal((await a.call('/api/profile',body)).status,400);
  const prohibited=await a.call('/api/profile',{area:'서울 동부',memo:'조건만남구함'});
  assert.equal(prohibited.status,422);
  assert.deepEqual((await a.call('/api/state')).body.profile,before);
  await a.call('/api/presence',{online:false});f.advance(1000);
  const changed=await a.call('/api/profile',{area:' 서울특별시 광진구 ',memo:'  새 소개글\n두 번째 줄  '});
  assert.equal(changed.status,200);
  const expected={...before,area:'서울 동부',memo:'새 소개글\n두 번째 줄'};
  assert.deepEqual(changed.body,{profile:expected});assert.deepEqual((await a.call('/api/state')).body.profile,expected);
  const person=(await b.call('/api/people')).body.find(p=>p.id===a.id);
  assert.equal(person.memo,expected.memo);assert.equal(person.area,expected.area);assert.equal(person.online,false);
  assert.deepEqual((await b.call('/api/people?area='+encodeURIComponent('서울특별시 광진구'))).body.map(p=>p.id),[a.id]);
  assert.deepEqual((await b.call('/api/people?area='+encodeURIComponent('경기 남부'))).body,[]);
  assert.equal((await b.call('/api/rooms?area='+encodeURIComponent('서울 동부'))).body[0].area,'서울 동부');
  const detail=(await admin('/api/admin/members/'+a.id)).body;
  assert.equal(detail.area,expected.area);assert.equal(detail.memo,expected.memo);assert.equal(detail.nick,before.nick);assert.equal(detail.year,before.year);assert.equal(detail.gender,before.gender);
  const managed=(await admin('/api/admin/rooms?area='+encodeURIComponent('서울특별시 광진구'))).body[0];
  assert.ok([managed.firstArea,managed.secondArea].includes('서울 동부'));
  assert.deepEqual((await b.call('/api/state')).body.profile,peerBefore);
  assert.equal(f.db.prepare('SELECT body FROM messages WHERE id=?').get(message).body,'기존 대화 보존');
  assert.equal((await a.call('/api/account/recovery')).body.code,a.code);
  for(const memo of ['가','가'.repeat(800)])assert.equal((await a.call('/api/profile',{area:'서울 동부',memo})).status,200);
  const saved=(await a.call('/api/state')).body.profile;
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(a.id);
  assert.equal((await a.call('/api/profile',{area:'부산 전체',memo:'제한된 변경'})).status,403);
  await a.call('/api/policy',{version:policyVersion});
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(f.db.prepare('SELECT identity FROM members WHERE id=?').get(a.id).identity,f.now()+hour);
  assert.equal((await a.call('/api/profile',{area:'부산 전체',memo:'제한된 변경'})).status,403);
  f.db.prepare('DELETE FROM restrictions').run();assert.deepEqual((await a.call('/api/state')).body.profile,saved);
  await admin('/api/admin/members/'+a.id+'/delete',{confirm:true});
  assert.equal((await a.call('/api/profile',{area:'부산 전체',memo:'삭제 뒤 변경'})).status,401);
  assert.equal(f.db.prepare('SELECT memo FROM members WHERE id=?').get(a.id).memo,saved.memo);
});

test('프로필 신고는 화면의 버전을 검증하고 수정 전 원문으로 심사하며 새 소개글은 보존한다',async t=>{
  const f=fixture(t),a=await f.register('작성자'),b=await f.register('신고자'),c=await f.register('다른 신고자'),admin=await f.admin();
  await a.call('/api/profile',{area:'서울 동부',memo:'신고 당시 소개글'});
  const shown=()=>b.call('/api/people').then(r=>r.body.find(p=>p.id===a.id));
  const first=await shown(),report={kind:'profile',peer:a.id,reason,profileVersion:first.profileVersion};
  assert.equal((await b.call('/api/report',{kind:'profile',peer:a.id,reason})).status,400);
  assert.equal((await b.call('/api/report',{...report,profileVersion:'forged'})).status,409);
  assert.equal((await b.call('/api/report',report)).status,200);
  await a.call('/api/profile',{area:'경기 북부',memo:first.memo});
  assert.equal((await shown()).profileVersion,first.profileVersion);
  await b.call('/api/report',report);await c.call('/api/report',report);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,2);
  await a.call('/api/profile',{area:'부산 전체',memo:'새로운 소개글은 별도 내용'});
  const edited=await shown();assert.notEqual(edited.profileVersion,first.profileVersion);
  assert.equal((await c.call('/api/report',report)).status,409);
  let queue=(await admin('/api/admin/review')).body.reports;
  assert.equal(queue[0].excerpt,first.memo);assert.equal(queue[0].area,first.area);assert.equal(queue[0].nick,first.nick);
  f.restart();queue=(await admin('/api/admin/review')).body.reports;
  assert.equal(queue[0].excerpt,first.memo);assert.equal(queue[0].profileSnapshotAvailable,true);
  assert.equal((await admin('/api/admin/review',{kind:'report',id:queue[0].id,action:'accept'})).status,200);
  assert.equal((await admin('/api/admin/review',{kind:'report',id:queue[1].id,action:'accept'})).status,200);
  const current=(await a.call('/api/state')).body;
  assert.equal(current.profile.memo,edited.memo);assert.equal(current.profile.nick,first.nick);assert.equal(current.totalStrikes,1);
  assert.equal((await b.call('/api/report',{...report,profileVersion:edited.profileVersion})).status,200);
  const next=(await admin('/api/admin/review')).body.reports[0];assert.equal(next.excerpt,edited.memo);
  await admin('/api/admin/review',{kind:'report',id:next.id,action:'accept'});
  const removed=(await a.call('/api/state')).body;
  assert.equal(removed.totalStrikes,2);assert.equal(removed.profile.memo,'운영자가 프로필 내용을 삭제했어요.');
});

test('지역·신고 snapshot 마이그레이션은 기존 계정과 대화를 보존하고 불명확한 신고 원문을 만들지 않는다',async t=>{
  const f=fixture(t),a=await f.register('기존 회원'),b=await f.register('상대 회원'),admin=await f.admin();
  const room=await f.room(a,b),message=await f.send(a,room,{body:'마이그레이션 이후에도 같은 대화'});
  const identity=f.db.prepare('SELECT identity FROM members WHERE id=?').get(a.id).identity;
  const safety=moderation(f.db),content=safety.profileContent(a.id);
  const insert=f.db.prepare("INSERT INTO reports(reporter,target,message,reason,created,content) VALUES(?,?,NULL,?,?,?)");
  const same=Number(insert.run(b.id,a.id,reason,f.now(),content).lastInsertRowid);
  const changed=Number(insert.run(b.id,a.id,reason,f.now(),'profile:'+a.id+':historical-unknown').lastInsertRowid);
  const missing=Number(insert.run(b.id,a.id,reason,f.now(),null).lastInsertRowid);
  f.db.prepare('UPDATE members SET area=? WHERE id=?').run('경기도 이천시',a.id);
  f.db.prepare('UPDATE members SET area=? WHERE id=?').run('미상 지역의 오래된 값',b.id);
  f.restart();f.restart();
  const state=(await a.call('/api/state')).body;
  assert.equal(state.profile.area,'경기 남부');assert.equal(state.profile.id,a.id);
  assert.equal((await b.call('/api/state')).body.profile.area,'지역 미선택');
  assert.equal((await a.call('/api/account/recovery')).body.code,a.code);
  assert.equal(f.db.prepare('SELECT identity FROM members WHERE id=?').get(a.id).identity,identity);
  assert.equal((await a.call('/api/rooms/'+room+'/messages')).body.find(m=>m.id===message).body,'마이그레이션 이후에도 같은 대화');
  const rows=f.db.prepare('SELECT id,content,profile_snapshot FROM reports ORDER BY id').all();
  assert.equal(JSON.parse(rows[0].profile_snapshot).memo,'소개');assert.equal(JSON.parse(rows[0].profile_snapshot).area,'경기도 이천시');
  assert.equal(rows[1].profile_snapshot,null);assert.equal(rows[2].profile_snapshot,null);assert.equal(rows[2].content,null);
  const queue=(await admin('/api/admin/review')).body.reports;
  assert.equal(queue.find(r=>r.id===same).profileSnapshotAvailable,true);
  for(const id of [changed,missing]){
    assert.equal(queue.find(r=>r.id===id).profileSnapshotAvailable,false);
    assert.match(queue.find(r=>r.id===id).excerpt,/원문을 확인할 수 없/);
    assert.equal((await admin('/api/admin/review',{kind:'report',id,action:'accept'})).status,409);
    assert.equal((await admin('/api/admin/review',{kind:'report',id,action:'dismiss'})).status,200);
  }
  assert.equal((await a.call('/api/state')).body.totalStrikes,0);
  assert.equal((await b.call('/api/profile',{area:'제주 전체',memo:'지역 다시 선택'})).status,200);
  assert.equal((await b.call('/api/state')).body.profile.area,'제주 전체');
});

test('나가기·차단은 양쪽 대화와 미발송 알림을 닫고 명시 재개방도 옛 메시지를 복원하지 않는다',async t=>{
  const f=fixture(t),a=await f.register('나가는 회원'),b=await f.register('상대 회원'),c=await f.register('외부 회원'),admin=await f.admin();
  const room=await f.room(a,b),path='/api/rooms/'+room+'/messages',leave='/api/rooms/'+room+'/leave';
  await b.call('/api/push/device',{platform:'android',token:'room-closure-push-token-1234'});
  const text=await f.send(a,room,{body:'원문 보존'}),image=await f.send(a,room,{photo:photo.toString('base64')});
  await b.call('/api/report',{kind:'message',message:text,reason});
  const first=(await b.call(path)).headers['x-room-version'];
  for(const user of [a,b])assert.equal((await user.call('/api/rooms')).body.length,1);
  assert.equal((await c.call(leave,{confirm:true})).status,404);
  assert.equal((await f.client()(leave,{confirm:true})).status,401);
  assert.equal((await a.call(leave,{confirm:false})).status,400);
  assert.equal((await a.call(leave,{confirm:true})).status,200);
  const closed=f.db.prepare('SELECT closed_at,closed_reason FROM rooms WHERE id=?').get(room);
  assert.equal(closed.closed_reason,'left');assert.equal(closed.closed_at,f.now());
  const version=f.db.prepare('SELECT version FROM room_changes WHERE room=?').get(room).version;
  assert.equal(version,Number(first)+1);
  f.advance(1000);assert.equal((await b.call(leave,{confirm:true})).status,200);
  assert.deepEqual(f.db.prepare('SELECT closed_at,closed_reason FROM rooms WHERE id=?').get(room),closed);
  assert.equal(f.db.prepare('SELECT version FROM room_changes WHERE room=?').get(room).version,version);
  for(const user of [a,b]) {
    assert.deepEqual((await user.call('/api/rooms')).body,[]);
    assert.deepEqual((await user.call('/api/unread')).body,{total:0,rooms:[]});
    assert.equal((await user.call(path)).status,404);
    assert.equal((await user.call(path,{body:'단순 전송으로 재개 불가'})).status,404);
    assert.equal((await user.call('/api/photos/'+image)).status,404);
    assert.equal((await user.call('/api/rooms/'+room+'/read',{through:image})).status,404);
  }
  assert.equal((await b.call('/api/report',{kind:'message',message:image,reason})).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,0);await f.queue.flush();assert.deepEqual(f.delivered,[]);
  const managed=(await admin('/api/admin/rooms/'+room+'/messages')).body;
  assert.equal(managed[0].body,'원문 보존');assert.ok(managed.every(m=>m.deleted));assert.equal(managed[1].viewable,1);
  assert.deepEqual((await admin('/api/admin/photos/'+image)).body,photo);
  assert.equal((await admin('/api/admin/rooms')).body[0].closedReason,'left');
  assert.equal((await admin('/api/admin/review')).body.reports[0].excerpt,'원문 보존');
  const reopened=await b.call('/api/room',{peer:a.id});
  assert.equal(reopened.body.id,room);assert.equal(reopened.body.version,version+1);
  assert.ok((await a.call(path)).body.every(m=>m.deleted && m.body===null && m.viewable===0));
  assert.equal((await b.call('/api/photos/'+image)).status,403);
  const next=await f.send(a,room,{body:'새 대화'});
  assert.equal((await b.call('/api/unread')).body.total,1);
  const pending=f.db.prepare('SELECT j.*,d.platform,d.token,s.member AS recipient FROM push_jobs j JOIN push_devices d ON d.id=j.device JOIN sessions s ON s.id=d.session WHERE j.message=?').get(next);
  assert.ok(pending);
  await a.call('/api/blocks',{peer:b.id});
  assert.equal(f.db.prepare('SELECT closed_reason FROM rooms WHERE id=?').get(room).closed_reason,'blocked');
  assert.equal((await b.call('/api/room',{peer:a.id})).status,404);
  await a.call('/api/blocks',{peer:b.id,remove:true});
  assert.deepEqual((await b.call('/api/rooms')).body,[]);
  assert.equal((await b.call(path,{body:'차단 해제만으로 재개 불가'})).status,404);
  await f.queue.flush();assert.deepEqual(f.delivered,[]);
  await f.room(a,b);assert.ok((await b.call(path)).body.every(m=>m.deleted));
  assert.equal((await b.call('/api/unread')).body.total,0);
  const report=(await admin('/api/admin/review')).body.reports[0];
  await admin('/api/admin/review',{kind:'report',id:report.id,action:'accept'});
  assert.equal(f.db.prepare('SELECT body FROM messages WHERE id=?').get(text).body,null);
});

test('SSE는 참여자의 현재 세션에만 삭제·폐쇄 신호를 보내고 로그아웃·회원 삭제·만료에 종료한다',async t=>{
  const f=fixture(t),a=await f.register('가'),b=await f.register('나'),c=await f.register('다'),admin=await f.admin();
  const room=await f.room(a,b),message=await f.send(a,room,{body:'이 내용은 신호에 포함 금지'});
  const as=f.events(a.call),bs=f.events(b.call),cs=f.events(c.call);
  assert.equal(as.status,200);assert.match(as.headers['content-type'],/text\/event-stream/);
  await a.call('/api/messages/'+message+'/delete',{confirm:true});
  const deleted={room,closed:false,deletedMessage:message,version:1};
  assert.deepEqual(as.events(),[deleted]);assert.deepEqual(bs.events(),[deleted]);assert.deepEqual(cs.events(),[]);
  assert.doesNotMatch(as.chunks.join(''),/이 내용|body|photo/);
  await a.call('/api/messages/'+message+'/delete',{confirm:true});assert.equal(as.events().length,1);
  await b.call('/api/rooms/'+room+'/leave',{confirm:true});
  assert.deepEqual(as.events()[1],{room,closed:true,reason:'left',version:2,closedAt:f.now()});
  await f.room(a,b);await a.call('/api/blocks',{peer:b.id});
  assert.equal(as.events()[2].version,4);assert.equal(as.events()[2].reason,'blocked');
  await a.call('/api/logout',{});assert.equal(as.writableEnded,true);assert.equal(bs.writableEnded,false);
  await admin('/api/admin/members/'+b.id+'/delete',{confirm:true});assert.equal(bs.writableEnded,true);assert.equal(cs.writableEnded,false);
  // A disconnected response is removed before later notifications.
  cs.end();assert.equal(cs.writableEnded,true);
  const d=await f.register('라'),cd=await f.room(c,d),ds=f.events(d.call),expired=f.events(c.call);
  f.db.prepare('UPDATE sessions SET expires=? WHERE member=?').run(f.now(),c.id);
  const dm=await f.send(d,cd,{body:'만료 연결에는 보내지 않음'});
  await d.call('/api/messages/'+dm+'/delete',{confirm:true});
  assert.equal(expired.writableEnded,true);assert.equal(expired.events().length,0);assert.equal(ds.events().length,1);
  f.restart();assert.equal(ds.writableEnded,true);
});

test('SSE heartbeat는 세션 만료를 확인하고 실제 HTTP 서버 종료는 열린 스트림을 기다리지 않는다',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture(t),a=await f.register('연결 회원'),stream=f.events(a.call);
  f.db.prepare('UPDATE sessions SET expires=? WHERE member=?').run(f.now(),a.id);
  t.mock.timers.tick(15000);assert.equal(stream.writableEnded,true);
  const b=await f.register('서버 종료 회원');
  const server=f.server();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cookie=[...b.call.cookies].map(([k,v])=>k+'='+v).join('; ');
  const response=await new Promise((resolve,reject)=>{
    const request=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/events',headers:{cookie}},res=>res.once('data',()=>resolve(res)));
    request.on('error',reject);
  });
  assert.equal(response.statusCode,200);
  const ended=new Promise(resolve=>response.once('end',resolve));response.resume();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await ended;
});

test('활동은 실제 가입·로그인·heartbeat로 기록하고 세션별 온라인은 90초 또는 세션 만료에 끝난다',async t=>{
  const f=fixture(t),a=await f.register('가을');f.advance(1000);
  const b=await f.register('봄');f.advance(1000);
  const c=await f.register('겨울','서울특별시 중구'),admin=await f.admin();
  let people=(await a.call('/api/people')).body;
  assert.deepEqual(people.map(p=>p.id),[c.id,b.id]);assert.ok(people.every(p=>p.online===true));
  assert.deepEqual((await a.call('/api/people?area='+encodeURIComponent(area))).body.map(p=>p.id),[b.id]);
  const lastSeen=people.find(p=>p.id===b.id).lastSeen;
  f.advance(5000);
  for(const path of ['/api/status','/api/state'])assert.equal((await b.call(path)).status,200);
  await admin('/api/admin/members');await admin('/api/admin/members/'+b.id);await admin('/api/admin/rooms');
  assert.equal(f.db.prepare('SELECT last_seen FROM member_activity WHERE member=?').get(b.id).last_seen,lastSeen);
  assert.equal((await f.client()('/api/presence',{online:true})).status,401);
  assert.equal((await b.call('/api/presence',{online:'yes'})).status,400);
  await b.call('/api/presence',{online:false});
  people=(await a.call('/api/people')).body;assert.equal(people.find(p=>p.id===b.id).online,false);
  assert.equal(people.find(p=>p.id===b.id).lastSeen,lastSeen);
  const second=f.client();assert.equal((await second('/api/account/login',{code:b.code})).status,200);
  await b.call('/api/presence',{online:false});
  assert.equal((await a.call('/api/people')).body.find(p=>p.id===b.id).online,true);
  assert.equal((await a.call('/api/people')).body[0].id,b.id);
  f.advance(89999);assert.equal((await a.call('/api/people')).body.find(p=>p.id===b.id).online,true);
  f.advance(1);assert.equal((await a.call('/api/people')).body.find(p=>p.id===b.id).online,false);
  await second('/api/presence',{online:true});
  f.db.prepare('UPDATE sessions SET expires=? WHERE member=?').run(f.now(),b.id);
  assert.equal((await a.call('/api/people')).body.find(p=>p.id===b.id).online,false);
  assert.equal((await second('/api/presence',{online:true})).status,401);
  // Late completion of ordinary requests must not undo a native offline signal.
  const ac=await f.room(a,c);
  await a.call('/api/presence',{online:false});
  const sent=await f.send(a,ac,{body:'백그라운드 전 시작한 요청'});
  await a.call('/api/rooms/'+ac+'/read',{through:sent});
  await a.call('/api/messages/'+sent+'/delete',{confirm:true});
  await a.call('/api/room',{peer:c.id});
  assert.equal((await c.call('/api/people')).body.find(p=>p.id===a.id).online,false);
  f.db.prepare('UPDATE member_activity SET last_seen=? WHERE member IN (?,?)').run(f.now(),b.id,c.id);
  assert.deepEqual((await a.call('/api/people')).body.map(p=>p.id),[b.id,c.id].sort());
});

test('30일 미접속 경계·페이지와 기존 활동 미상 회원의 관측 시작일을 보존한다',async t=>{
  const f=fixture(t),a=await f.register('활동회원'),b=await f.register('미접속회원'),admin=await f.admin();
  f.db.prepare('UPDATE member_activity SET last_seen=? WHERE member=?').run(f.now()-30*day+1,b.id);
  assert.equal((await admin('/api/admin/members?filter=inactive')).body.items.length,0);
  f.advance(1);
  const inactive=(await admin('/api/admin/members?filter=inactive')).body;
  assert.deepEqual(inactive.items.map(m=>m.id),[b.id]);assert.equal(inactive.counts.inactive,1);
  assert.equal(inactive.items[0].status,'active');
  const before=inactive.items[0].lastSeen;
  await admin('/api/admin/members/'+b.id);await b.call('/api/status');
  assert.equal((await admin('/api/admin/members?filter=inactive')).body.items[0].lastSeen,before);
  const legacy=randomUUID();
  f.db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)').run(legacy,'legacy-identity','기존 회원',1995,'여성',area,'소개');
  f.restart();
  const observed=f.db.prepare('SELECT last_seen FROM member_activity WHERE member=?').get(legacy).last_seen;
  assert.equal(observed,f.now());
  f.advance(1000);f.restart();
  assert.equal(f.db.prepare('SELECT last_seen FROM member_activity WHERE member=?').get(legacy).last_seen,observed);
  assert.ok(!(await admin('/api/admin/members?filter=inactive')).body.items.some(m=>m.id===legacy));
  assert.equal((await admin('/api/admin/members?filter=invalid')).status,400);
  for(let n=0;n<52;n++){
    const id=randomUUID();f.db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)').run(id,id,'휴면'+String(n).padStart(2,'0'),1995,'여성',area,'소개');
    f.db.prepare('INSERT INTO member_activity VALUES(?,?)').run(id,f.now()-31*day);
  }
  const first=(await admin('/api/admin/members?filter=inactive')).body;
  const second=(await admin('/api/admin/members?filter=inactive&offset=50')).body;
  assert.equal(first.items.length,50);assert.equal(first.more,true);assert.equal(second.items.length,3);assert.equal(second.more,false);
  assert.equal(new Set([...first.items,...second.items].map(m=>m.id)).size,53);
  await b.call('/api/presence',{online:true});assert.equal((await admin('/api/admin/members?filter=inactive')).body.counts.inactive,52);
});

test('본인 메시지 삭제는 양쪽에서 원문을 차단하고 관리자 원문·버전·읽음·푸시를 원자적으로 반영한다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('수신자'),c=await f.register('외부회원'),admin=await f.admin();
  const room=await f.room(a,b),path='/api/rooms/'+room+'/messages';
  await b.call('/api/push/device',{platform:'android',token:'token-for-recipient-12345'});
  const message=await f.send(a,room,{body:'삭제 전 원문을 관리자에게 보존'});
  assert.equal((await b.call('/api/unread')).body.total,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,1);
  const action='/api/messages/'+message+'/delete';
  for(const user of [b,c])assert.equal((await user.call(action,{confirm:true})).status,404);
  assert.equal((await f.client()(action,{confirm:true})).status,401);
  assert.equal((await a.call(action,{confirm:false})).status,400);
  const before=(await b.call(path)).headers['x-room-version'];
  assert.equal((await a.call(action,{confirm:true})).status,200);
  const first=f.db.prepare('SELECT deleted_at FROM messages WHERE id=?').get(message).deleted_at;
  f.advance(10);assert.equal((await a.call(action,{confirm:true})).status,200);
  assert.equal(f.db.prepare('SELECT deleted_at FROM messages WHERE id=?').get(message).deleted_at,first);
  for(const user of [a,b]){
    const current=await user.call(path);const row=current.body.find(m=>m.id===message);
    assert.equal(row.visibility,'deleted');assert.equal(row.deleted,true);assert.equal(row.body,null);assert.equal(row.viewable,0);
    assert.doesNotMatch(JSON.stringify(current.body),/삭제 전 원문|archivedBody|archivedLive/);
    assert.equal(Number(current.headers['x-room-version']),Number(before)+1);
  }
  assert.equal((await b.call('/api/unread')).body.total,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM push_jobs').get().n,0);
  await f.queue.flush();assert.equal(f.delivered.length,0);
  assert.equal((await a.call('/api/admin/deleted-messages')).status,401);
  assert.equal((await admin('/api/admin/deleted-messages')).status,404);
  const archived=(await admin('/api/admin/rooms/'+room+'/messages')).body[0];
  assert.equal(archived.body,'삭제 전 원문을 관리자에게 보존');assert.equal(archived.deletedAt,first);assert.equal(archived.room,room);
  assert.equal((await admin('/api/admin/rooms/'+room+'/messages')).body[0].body,archived.body);
  assert.equal((await a.call('/api/rooms')).body[0].id,room);
  const after=await f.send(a,room,{body:'차단 뒤에도 본인 삭제'});
  await b.call('/api/blocks',{peer:a.id});
  assert.equal((await a.call('/api/messages/'+after+'/delete',{confirm:true})).status,200);
  assert.equal((await admin('/api/admin/rooms/'+room+'/messages')).body.length,2);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='deleted_messages'").get(),undefined);
});

test('삭제 사진도 원래 12시간 만료를 지키고 신고 인정 시 원문을 완전히 제거한다',async t=>{
  const f=fixture(t),a=await f.register('발신자'),b=await f.register('수신자'),c=await f.register('외부회원'),admin=await f.admin();
  const room=await f.room(a,b),path='/api/rooms/'+room+'/messages';
  const live=await f.send(a,room,{photo:photo.toString('base64')});
  await b.call('/api/report',{kind:'message',message:live,reason});
  await a.call('/api/messages/'+live+'/delete',{confirm:true});
  for(const user of [a,b])assert.equal((await user.call('/api/photos/'+live)).status,403);
  assert.equal((await c.call('/api/photos/'+live)).status,404);
  assert.deepEqual((await admin('/api/admin/photos/'+live)).body,photo);
  const reported=(await admin('/api/admin/review')).body.reports[0];assert.equal(reported.photo,live);
  assert.equal((await admin('/api/admin/review',{kind:'report',id:reported.id,action:'accept'})).status,200);
  assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(live).photo,null);
  assert.equal((await admin('/api/admin/photos/'+live)).status,410);
  assert.equal((await b.call(path)).body[0].visibility,'deleted');
  const dismissed=await f.send(a,room,{photo:photo.toString('base64')});
  await b.call('/api/report',{kind:'message',message:dismissed,reason});
  await a.call('/api/messages/'+dismissed+'/delete',{confirm:true});
  const pending=(await admin('/api/admin/review')).body.reports[0];
  await admin('/api/admin/review',{kind:'report',id:pending.id,action:'dismiss'});
  assert.equal((await b.call(path)).body.find(m=>m.id===dismissed).visibility,'deleted');
  assert.deepEqual((await admin('/api/admin/photos/'+dismissed)).body,photo);
  const sent=f.db.prepare('SELECT sent FROM messages WHERE id=?').get(dismissed).sent;
  f.advance(12*hour-1);await f.admin(admin);
  assert.equal(f.now(),sent+12*hour-1);assert.equal((await admin('/api/admin/photos/'+dismissed)).status,200);
  f.advance(1);
  assert.equal((await admin('/api/admin/photos/'+dismissed)).status,410);
  assert.equal((await admin('/api/admin/rooms/'+room+'/messages')).body.find(m=>m.id===dismissed).viewable,0);
  clean(f.db,f.now());assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(dismissed).photo,null);
  const expired=await f.send(a,room,{photo:photo.toString('base64')});
  f.db.prepare('UPDATE messages SET expires=? WHERE id=?').run(f.now(),expired);
  await a.call('/api/messages/'+expired+'/delete',{confirm:true});
  assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(expired).photo,null);
  assert.equal((await admin('/api/admin/photos/'+expired)).status,410);
  const removed=await f.send(a,room,{photo:photo.toString('base64')});
  await b.call('/api/report',{kind:'message',message:removed,reason});
  const report=(await admin('/api/admin/review')).body.reports[0];await admin('/api/admin/review',{kind:'report',id:report.id,action:'accept'});
  await a.call('/api/messages/'+removed+'/delete',{confirm:true});
  assert.equal((await admin('/api/admin/photos/'+removed)).status,410);
  assert.equal(f.db.prepare('SELECT photo FROM messages WHERE id=?').get(removed).photo,null);
});

test('관리자 회원 삭제는 모든 인증·푸시·가입예약을 폐기하고 보존된 관리기록이나 다른 회원 세션은 건드리지 않는다',async t=>{
  const f=fixture(t),a=await f.register('삭제회원'),b=await f.register('유지회원'),c=await f.register('다른회원'),admin=await f.admin();
  const ab=await f.room(a,b),bc=await f.room(b,c);
  const a2=f.client(),a3=f.client();
  for(const device of [a2,a3])assert.equal((await device('/api/account/login',{code:a.code})).status,200);
  await f.admin(a.call); // A member deletion must not revoke this separate administrator session.
  for(const [call,token] of [[a.call,'target-first-device-token'],[a2,'target-second-device-token'],[b.call,'recipient-device-token-123'],[c.call,'unrelated-device-token-123']])
    await call('/api/push/device',{platform:'android',token});
  const archived=await f.send(a,ab,{body:'관리자 보존 원문'});await a.call('/api/messages/'+archived+'/delete',{confirm:true});
  const image=await f.send(a,ab,{photo:photo.toString('base64')});
  const unrelated=await f.send(b,bc,{body:'다른 회원 알림'});
  await a2('/api/logout',{});await a2('/api/key',{code:'pending-key'});
  const independent=f.client();await independent('/api/key',{code:'pending-key'});
  await independent('/api/profile-details',{nick:'독립 가입',birthDate:'1995-01-03',gender:'여성'});
  const independentProof=f.db.prepare("SELECT identity FROM sessions WHERE nick='독립 가입'").get().identity;
  await a3('/api/logout',{});
  let release,started;const ready=new Promise(resolve=>started=resolve);
  const originalCheck=f.upstream.check;
  f.upstream.check=async code=>code==='delayed-key'?new Promise(resolve=>{release=resolve;started();}):originalCheck(code);
  const inFlight=a3('/api/key',{code:'delayed-key'});await ready;
  const remove='/api/admin/members/'+a.id+'/delete';
  assert.equal((await b.call(remove,{confirm:true})).status,401);
  assert.equal((await admin(remove,{confirm:false})).status,400);
  assert.equal((await admin(remove,{confirm:true})).status,200);
  assert.equal((await admin(remove,{confirm:true})).status,200);
  release({status:'approved',token:'late'});assert.equal((await inFlight).status,409);
  for(const user of [a.call,a2,a3]){
    assert.equal((await user('/api/state')).body.stage,'gate');
    assert.equal((await user('/api/status')).body.stage,'gate');
    assert.equal((await user('/api/presence',{online:true})).status,401);
  }
  assert.equal((await a.call('/api/admin/settings')).status,200);
  assert.equal((await a.call('/api/account/login',{code:a.code})).status,403);
  for(const table of ['account_keys','account_devices','contacts','acceptances','room_reads'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE member=?').get(a.id).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE member=?').get(a.id).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM signup_gates').get().n,1);
  assert.ok(f.db.prepare('SELECT 1 FROM signup_gates WHERE proof=?').get(independentProof));
  assert.equal((await independent('/api/state')).body.stage,'details');
  assert.ok(f.db.prepare('SELECT deleted_at FROM members WHERE id=?').get(a.id).deleted_at);
  const listing=(await admin('/api/admin/members')).body;
  assert.equal(listing.counts.active,2);assert.ok(!listing.items.some(m=>m.id===a.id));
  assert.equal((await admin('/api/admin/members/'+a.id)).body.status,'deleted');
  assert.ok(!(await b.call('/api/people')).body.some(m=>m.id===a.id));
  assert.deepEqual((await b.call('/api/rooms')).body.map(r=>r.id),[bc]);
  assert.equal((await b.call('/api/room',{peer:a.id})).status,404);
  assert.equal((await b.call('/api/photos/'+image)).status,404);
  assert.equal((await admin('/api/admin/rooms')).body.length,2);
  assert.equal((await admin('/api/admin/rooms/'+ab+'/messages')).body[0].body,'관리자 보존 원문');
  assert.deepEqual((await admin('/api/admin/photos/'+image)).body,photo);
  assert.equal((await b.call('/api/state')).body.stage,'member');assert.equal((await c.call('/api/state')).body.stage,'member');
  await f.queue.flush();assert.deepEqual(f.delivered,[unrelated]);
  f.restart();
  assert.equal((await independent('/api/state')).body.stage,'details');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE member=?').get(a.id).n,0);
  assert.equal((await a.call('/api/account/login',{code:a.code})).status,403);
  assert.equal((await admin('/api/admin/rooms/'+ab+'/messages')).body[0].body,'관리자 보존 원문');
  const replacement=await f.register('새 가입',area,a.call);assert.notEqual(replacement.id,a.id);
  assert.equal((await replacement.call('/api/rooms/'+ab+'/messages')).status,404);
  // Existing self-withdrawal still hard-deletes its rooms and messages.
  await b.call('/api/withdraw',{confirm:true});
  assert.equal(f.db.prepare('SELECT 1 FROM messages WHERE id=?').get(archived),undefined);
  assert.equal((await admin('/api/admin/rooms/'+ab+'/messages')).status,404);
  await admin('/api/admin/reset',{key:'codenote-test-kyh',confirm:'전체 삭제'});
  for(const table of tables)assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
});

test('기존 키 예약은 진행 중 입력과 만료시간을 보존해 이관하고 다른 기기 승인과 기존 계정은 유지한다',async t=>{
  const f=fixture(t),member=await f.register('기존 계정'),admin=await f.admin();
  const oldProfile=(await member.call('/api/state')).body.profile;
  async function legacy(nick,remaining) {
    const call=f.client();await call('/api/key',{code:'same-legacy-key'});
    await call('/api/profile-details',{nick,birthDate:'1994-07-08',gender:'남성'});
    const session=f.db.prepare('SELECT * FROM sessions WHERE nick=?').get(nick);
    const gate=f.db.prepare('SELECT * FROM signup_gates WHERE proof=?').get(session.identity);
    const oldProof='legacy-'+nick,expires=f.now()+remaining;
    f.db.prepare('DELETE FROM signup_gates WHERE proof=?').run(gate.proof);
    f.db.prepare('INSERT INTO used_invites VALUES(?,?,?)').run(oldProof,gate.device,expires);
    f.db.prepare('UPDATE sessions SET identity=?,expires=? WHERE id=?').run(oldProof,f.now()+4*hour,session.id);
    return {call,session,gate,oldProof,expires};
  }
  const active=await legacy('유지할 입력',5*hour),lost=await legacy('쿠키 유실',3*hour),expired=await legacy('만료 입력',-1);
  lost.call.cookies.delete('pc_user');
  f.db.prepare('INSERT INTO used_invites VALUES(?,NULL,NULL)').run('already-used-history');
  const other=f.client();await other('/api/key',{code:'same-legacy-key'});
  await other('/api/profile-details',{nick:'새 방식 독립 기기',birthDate:'1995-01-03',gender:'여성'});
  const otherProof=f.db.prepare("SELECT identity FROM sessions WHERE nick='새 방식 독립 기기'").get().identity;
  f.restart();
  const migrated=f.db.prepare('SELECT * FROM signup_gates WHERE device=?').get(active.gate.device);
  assert.notEqual(migrated.proof,active.oldProof);assert.notEqual(migrated.proof,active.gate.proof);
  assert.equal(migrated.expires,active.expires);
  const session=f.db.prepare('SELECT * FROM sessions WHERE id=?').get(active.session.id);
  assert.equal(session.identity,migrated.proof);assert.equal(session.expires,f.now()+4*hour);
  assert.equal(session.kind,'details');assert.equal(session.nick,'유지할 입력');assert.equal(session.year,1994);assert.equal(session.gender,'남성');
  assert.equal((await active.call('/api/state')).body.stage,'details');
  assert.equal((await lost.call('/api/state')).body.stage,'gate_ok');
  assert.equal(f.db.prepare('SELECT expires FROM signup_gates WHERE device=?').get(lost.gate.device).expires,lost.expires);
  assert.equal((await expired.call('/api/state')).body.stage,'gate');
  assert.equal(f.db.prepare('SELECT 1 FROM signup_gates WHERE device=?').get(expired.gate.device),undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(expired.session.id),undefined);
  assert.ok(f.db.prepare('SELECT 1 FROM signup_gates WHERE proof=?').get(otherProof));
  assert.ok(f.db.prepare('SELECT pending_device,pending_until FROM used_invites').all().every(r=>r.pending_device===null && r.pending_until===null));
  f.restart();assert.deepEqual(f.db.prepare('SELECT * FROM signup_gates WHERE device=?').get(active.gate.device),migrated);
  assert.deepEqual((await member.call('/api/state')).body.profile,oldProfile);
  assert.equal((await member.call('/api/account/recovery')).body.code,member.code);
  assert.equal((await admin('/api/admin/members')).body.counts.active,1);
  const stale=f.client();for(const [key,value]of active.call.cookies)stale.cookies.set(key,value);
  const body={area,memo:'이관 후 가입',policy:policyVersion};
  const results=await Promise.all([active.call('/api/register',body),stale('/api/register',body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const newMember=(await active.call('/api/state')).body.profile;
  assert.equal(newMember.nick,'유지할 입력');assert.equal(newMember.year,1994);assert.equal(newMember.gender,'남성');
  assert.equal((await other('/api/state')).body.stage,'details');
  assert.equal((await other('/api/register',body)).status,200);
  assert.notEqual((await other('/api/state')).body.profile.id,newMember.id);
  assert.equal((await admin('/api/admin/members')).body.counts.active,3);
  assert.equal((await member.call('/api/account/recovery')).body.code,member.code);
});

test('구형 DB에 열을 추가할 때 기존 메시지·회원은 보존하고 관측일을 한 번만 설정한다',t=>{
  const dir=mkdtempSync(join(tmpdir(),'paperchat-old-schema-'));let db=new DatabaseSync(join(dir,'chat.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec(`CREATE TABLE members(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,nick TEXT NOT NULL,year INTEGER NOT NULL,gender TEXT NOT NULL,area TEXT NOT NULL,memo TEXT NOT NULL);
    CREATE TABLE rooms(id TEXT PRIMARY KEY,a TEXT NOT NULL REFERENCES members ON DELETE CASCADE,b TEXT NOT NULL REFERENCES members ON DELETE CASCADE,UNIQUE(a,b));
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL REFERENCES rooms ON DELETE CASCADE,author TEXT NOT NULL REFERENCES members ON DELETE CASCADE,sent INTEGER NOT NULL,body TEXT,photo BLOB,expires INTEGER);`);
  for(const id of ['one','two'])db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?)').run(id,id,id,1995,'여성',area,'소개');
  db.prepare('INSERT INTO rooms VALUES(?,?,?)').run('room','one','two');
  db.prepare('INSERT INTO messages(room,author,sent,body) VALUES(?,?,?,?)').run('room','one',1,'기존 대화');
  db.close();const before=Date.now();db=openStore(dir);
  const seen=db.prepare('SELECT last_seen FROM member_activity WHERE member=?').get('one').last_seen;
  assert.ok(seen>=before);assert.equal(db.prepare('SELECT body,deleted_at FROM messages').get().body,'기존 대화');
  assert.equal(db.prepare('SELECT deleted_at FROM messages').get().deleted_at,null);
  db.close();db=openStore(dir);assert.equal(db.prepare('SELECT last_seen FROM member_activity WHERE member=?').get('one').last_seen,seen);
});

test('레거시 삭제 보관함은 원래 메시지로 한 번만 합치고 만료·신고 확정 원문은 복원하지 않는다',t=>{
  const dir=mkdtempSync(join(tmpdir(),'paperchat-archive-migrate-'));let db=openStore(dir);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const now=Date.now(),sent=now-hour,deleted=now-1000;
  for(const id of ['author','peer'])db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)').run(id,id,id,1995,'여성',area,'소개');
  db.prepare('INSERT INTO rooms(id,a,b) VALUES(?,?,?)').run('room','author','peer');
  db.exec('CREATE TABLE deleted_messages(message INTEGER PRIMARY KEY REFERENCES messages ON DELETE CASCADE,body TEXT,photo BLOB,deleted_at INTEGER NOT NULL)');
  const ids={};
  for(const [name,body,expires] of [
    ['text','삭제한 원문',null],['live',null,sent+12*hour],['expired',null,now-1],
    ['removed',null,sent+12*hour],['accepted',null,sent+12*hour],['acceptedText','복원하면 안 되는 원문',null],
    ['overlong',null,sent+48*hour],['shorter',null,now+hour]
  ]) {
    const id=Number(db.prepare('INSERT INTO messages(room,author,sent,body,photo,expires,deleted_at) VALUES(?,?,?,?,?,?,?)').run('room','author',sent,null,null,expires,deleted).lastInsertRowid);
    ids[name]=id;db.prepare('INSERT INTO deleted_messages VALUES(?,?,?,?)').run(id,body,expires?photo:null,deleted);
  }
  db.prepare("INSERT INTO reviews VALUES(?,'removed')").run(ids.removed);
  for(const id of [ids.accepted,ids.acceptedText])db.prepare("INSERT INTO reports(reporter,target,message,reason,created,status) VALUES(?,?,?,?,?,'accept')").run('peer','author',id,reason,now);
  db.prepare('INSERT INTO blocks VALUES(?,?)').run('peer','author');
  db.close();db=openStore(dir);
  const row=name=>db.prepare('SELECT * FROM messages WHERE id=?').get(ids[name]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='deleted_messages'").get(),undefined);
  assert.equal(row('text').body,'삭제한 원문');assert.equal(row('text').deleted_at,deleted);
  assert.deepEqual(Buffer.from(row('live').photo),photo);assert.equal(row('live').expires,sent+12*hour);
  assert.equal(row('overlong').expires,sent+12*hour);assert.equal(row('shorter').expires,now+hour);
  for(const name of ['expired','removed','accepted'])assert.equal(row(name).photo,null);
  assert.equal(row('acceptedText').body,null);
  assert.equal(db.prepare('SELECT state FROM reviews WHERE message=?').get(ids.accepted).state,'removed');
  const closed=db.prepare('SELECT closed_at,closed_reason FROM rooms WHERE id=?').get('room');
  assert.equal(closed.closed_reason,'blocked');assert.ok(closed.closed_at>=now);
  assert.equal(db.prepare('SELECT version FROM room_changes WHERE room=?').get('room').version,1);
  db.close();db=openStore(dir);
  assert.equal(row('text').body,'삭제한 원문');assert.equal(row('text').deleted_at,deleted);
  assert.deepEqual(db.prepare('SELECT closed_at,closed_reason FROM rooms WHERE id=?').get('room'),closed);
  assert.equal(db.prepare('SELECT version FROM room_changes WHERE room=?').get('room').version,1);
  clean(db,sent+12*hour);
  assert.ok(db.prepare('SELECT photo FROM messages').all().every(m=>m.photo===null));
});
