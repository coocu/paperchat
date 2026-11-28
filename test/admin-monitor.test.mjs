import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { makeServer } from '../server.mjs';
import { openStore,hour } from '../store.mjs';
import { policyVersion } from '../public/rules.js';

const profiles='/api/admin/monitor/profiles',rooms='/api/admin/rooms';
const query=value=>encodeURIComponent(value);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-admin-monitor-')),origin='https://paperchat.example';
  let now=Date.UTC(2026,10,28,0,0,0),approved=true;
  const checks=[];
  t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const server=makeServer({dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}},
  {async check(code){checks.push(code);return {status:approved?'approved':'expired',token:'test-token'};}});
  const db=openStore(dir);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    return async(path,body)=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin,'user-agent':'test-browser',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(k){return headers[k.toLowerCase()];},setHeader(k,v){headers[k.toLowerCase()]=v;},
          writeHead(status,h){this.status=status;for(const [k,v]of Object.entries(h||{}))this.setHeader(k,v);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(e){reject(e);}
      });
    };
  }
  async function member(nick,area='서울 동부') {
    const call=client();
    assert.equal((await call('/api/key',{code:'member-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area,memo:'관리자 프로필 검증',policy:policyVersion})).status,200);
    return {call,id:(await call('/api/state')).body.profile.id};
  }
  async function admin(){const call=client();assert.equal((await call('/api/admin/login',{key:'codenote-monitor-kyh'})).status,200);return call;}
  async function room(a,b){const response=await a.call('/api/room',{peer:b.id});assert.equal(response.status,200);return response.body.id;}
  async function send(a,room,body){const response=await a.call('/api/rooms/'+room+'/messages',{body});assert.equal(response.status,200);return db.prepare('SELECT MAX(id) AS id FROM messages WHERE room=?').get(room).id;}
  async function consistent(admin,q) {
    const response=await admin(profiles+'?q='+query(q));assert.equal(response.status,200);
    for(const profile of response.body){
      const selected=await admin(rooms+'?member='+profile.id+'&q='+query(q));
      assert.equal(selected.status,200);assert.equal(selected.body.length,profile.matchedRoomCount);
    }
    return response.body;
  }
  return {db,client,member,admin,room,send,consistent,checks,now:()=>now,advance(ms){now+=ms;},approved(value){approved=value;}};
}

test('monitor profiles group every participating room and separate profile-region from room-region filters',async t=>{
  const f=fixture(t),a=await f.member('Alpha'),b=await f.member('Beta','부산 전체'),c=await f.member('Gamma'),d=await f.member('Delta','인천 전체');
  const nobody=await f.member('대화 없는 회원'),admin=await f.admin();
  const ab=await f.room(a,b),ac=await f.room(a,c),bc=await f.room(b,c),ad=await f.room(a,d);
  await f.send(a,ab,'첫 대화');f.advance(1000);await f.send(a,ac,'두 번째 대화');f.advance(1000);await f.send(b,bc,'가장 최근 대화');
  assert.equal((await a.call('/api/rooms/'+ab+'/leave',{confirm:true})).status,200);
  const list=(await admin(profiles)).body,byId=new Map(list.map(profile=>[profile.id,profile]));
  assert.equal(list.length,4);assert.equal(byId.has(nobody.id),false);
  for(const [member,count]of [[a,3],[b,2],[c,2],[d,1]]){
    assert.equal(byId.get(member.id).roomCount,count);assert.equal(byId.get(member.id).matchedRoomCount,count);
  }
  assert.deepEqual(Object.keys(byId.get(a.id)).sort(),['area','deletedAt','gender','id','lastSeen','matchedRoomCount','memo','nick','online','recent','roomCount','year']);
  assert.equal(byId.get(b.id).recent,f.now());assert.equal(byId.get(d.id).recent,null);
  const regional=(await admin(profiles+'?area='+query('서울 동부'))).body;
  assert.deepEqual(regional.map(profile=>profile.id).sort(),[a.id,c.id].sort());assert.equal(regional.find(profile=>profile.id===a.id).roomCount,3);
  const selected=(await admin(rooms+'?member='+a.id)).body;
  assert.deepEqual(selected.map(room=>room.id).sort(),[ab,ac,ad].sort());
  for(const room of selected){
    assert.ok([room.firstId,room.secondId].includes(a.id));assert.equal(room.matchingMessages,0);
    assert.equal(room.matchSnippet,null);assert.equal(room.matchDeletedAt,null);assert.equal(room.matchSent,null);assert.equal(Object.hasOwn(room,'matchBody'),false);
  }
  assert.equal(selected.find(room=>room.id===ab).closedReason,'left');
  assert.deepEqual((await admin(rooms+'?member='+a.id+'&area='+query('부산 전체'))).body.map(room=>room.id),[ab]);
  assert.deepEqual((await admin(rooms+'?member='+d.id+'&area='+query('부산 전체'))).body,[]);
  assert.deepEqual((await admin(rooms+'?area='+query('부산 전체'))).body.map(room=>room.id).sort(),[ab,bc].sort());
  const nameMatches=await f.consistent(admin,'  ALPHA  ');
  assert.equal(nameMatches.find(profile=>profile.id===a.id).matchedRoomCount,3);
  for(const member of [b,c,d])assert.equal(nameMatches.find(profile=>profile.id===member.id).matchedRoomCount,1);
  assert.equal((await admin('/api/admin/members/'+b.id+'/delete',{confirm:true})).status,200);
  const remaining=(await admin(profiles)).body;
  assert.equal(remaining.some(profile=>profile.id===b.id),false);
  assert.equal(remaining.find(profile=>profile.id===a.id).roomCount,2);
  assert.equal(remaining.find(profile=>profile.id===c.id).roomCount,1);
  assert.equal((await admin(rooms+'?member='+b.id)).status,404);
  assert.deepEqual((await admin(rooms)).body.map(room=>room.id).sort(),[ac,ad].sort());
  for(const deletedRoom of [ab,bc])assert.equal((await admin(rooms+'/'+deletedRoom+'/messages')).status,404);
  assert.deepEqual((await admin(profiles+'?q='+query('Beta'))).body,[]);
});

test('monitor profile order follows last access across search and region filters with stable ties and unknown activity last',async t=>{
  const f=fixture(t),a=await f.member('가장 앞 이름'),b=await f.member('중간 이름'),c=await f.member('같은 접속','부산 전체'),unknown=await f.member('접속 미상');
  const admin=await f.admin(),ab=await f.room(a,b),ac=await f.room(a,c),au=await f.room(a,unknown);
  await f.send(a,ab,'최근대화 순서와 접속순서는 별개');f.advance(1000);await f.send(unknown,au,'이 방 대화가 가장 최근');
  const updated=f.db.prepare('UPDATE member_activity SET last_seen=? WHERE member=?');
  updated.run(f.now()-10000,a.id);updated.run(f.now()-1000,b.id);updated.run(f.now()-1000,c.id);
  f.db.prepare('DELETE FROM member_activity WHERE member=?').run(unknown.id);
  f.db.prepare('UPDATE session_presence SET online=0 WHERE session IN (SELECT id FROM sessions WHERE member=?)').run(c.id);
  const expected=[...[b.id,c.id].sort(),a.id,unknown.id],activity=f.db.prepare('SELECT * FROM member_activity ORDER BY member').all();
  const global=(await admin(profiles)).body;
  assert.deepEqual(global.map(p=>p.id),expected);
  assert.equal(global.find(p=>p.id===b.id).online,true);assert.equal(global.find(p=>p.id===c.id).online,false);
  assert.equal(global.at(-1).lastSeen,null);assert.equal(global.at(-1).recent,f.now());
  assert.equal(global.find(p=>p.id===c.id).recent,null);
  assert.deepEqual((await admin(profiles+'?area='+query('서울 동부'))).body.map(p=>p.id),[b.id,a.id,unknown.id]);
  assert.deepEqual((await admin(profiles+'?q='+query('이 방 대화'))).body.map(p=>p.id),[a.id,unknown.id]);
  // Ordinary member discovery already uses the same last-access order.
  assert.deepEqual((await unknown.call('/api/people')).body.map(p=>p.id),expected.filter(id=>id!==unknown.id));
  assert.deepEqual(f.db.prepare('SELECT * FROM member_activity ORDER BY member').all(),activity);
});

test('room metadata exposes only the two ordered participant profiles to an approved administrator without touching activity',async t=>{
  const f=fixture(t),a=await f.member('첫 참가자'),b=await f.member('둘째 참가자','부산 전체'),outsider=await f.member('다른 회원'),admin=await f.admin();
  const room=await f.room(a,b),url=rooms+'/'+room;
  assert.equal((await f.client()(url)).status,401);assert.equal((await a.call(url)).status,401);assert.equal((await outsider.call(url)).status,401);
  assert.equal((await admin(rooms+'/'+randomUUID())).status,404);
  f.db.prepare('UPDATE member_activity SET last_seen=? WHERE member=?').run(f.now()-90000,a.id);
  f.db.prepare('UPDATE session_presence SET online=0 WHERE session IN (SELECT id FROM sessions WHERE member=?)').run(a.id);
  const activity=f.db.prepare('SELECT * FROM member_activity ORDER BY member').all();
  const response=await admin(url);assert.equal(response.status,200);assert.match(response.headers['cache-control'],/no-store/);
  const ordered=f.db.prepare('SELECT a,b FROM rooms WHERE id=?').get(room);
  assert.deepEqual(Object.keys(response.body).sort(),['id','participants']);assert.equal(response.body.id,room);
  assert.deepEqual(response.body.participants.map(p=>p.id),[ordered.a,ordered.b]);
  for(const profile of response.body.participants){
    assert.deepEqual(Object.keys(profile).sort(),['area','gender','id','lastSeen','memo','nick','online','year']);
    assert.equal(profile.year,1995);assert.equal(profile.gender,'여성');assert.equal(profile.memo,'관리자 프로필 검증');
  }
  assert.equal(response.body.participants.find(p=>p.id===a.id).online,false);
  assert.equal(response.body.participants.find(p=>p.id===b.id).online,true);
  assert.deepEqual(f.db.prepare('SELECT * FROM member_activity ORDER BY member').all(),activity);
  const messages=await admin(url+'/messages');assert.ok(Array.isArray(messages.body));assert.equal(messages.headers['x-room-version'],'0');
  await a.call('/api/rooms/'+room+'/leave',{confirm:true});
  assert.deepEqual((await admin(url)).body.participants.map(p=>p.id),[ordered.a,ordered.b]);
  await admin('/api/admin/members/'+a.id+'/delete',{confirm:true});assert.equal((await admin(url)).status,404);
  const surviving=await f.room(b,outsider);f.approved(false);
  assert.equal((await admin(rooms+'/'+surviving)).status,401);
});

test('literal Unicode text search counts rooms and produces a short snippet around the latest matching message',async t=>{
  const f=fixture(t),a=await f.member('첫 사람'),b=await f.member('둘 사람'),c=await f.member('셋 사람'),admin=await f.admin();
  const ab=await f.room(a,b),ac=await f.room(a,c);
  await f.send(a,ab,'CAFÉ 공지 100%_완료');await f.send(a,ac,'café 공지 100XX완료');
  const literal=(await admin(rooms+'?q='+query('%_'))).body;
  assert.deepEqual(literal.map(room=>room.id),[ab]);assert.equal(literal[0].matchingMessages,1);
  const unicode=await f.consistent(admin,'café');assert.equal(unicode.find(profile=>profile.id===a.id).matchedRoomCount,2);
  assert.deepEqual((await admin(rooms+'?q='+query("%' OR 1=1 --"))).body,[]);
  assert.deepEqual((await admin(profiles+'?q='+query("%' OR 1=1 --"))).body,[]);
  const longQuery='찾'.repeat(200),body='앞'.repeat(700)+longQuery+'뒤'.repeat(500);
  f.advance(1000);const latest=await f.send(a,ab,body),sent=f.now();
  f.advance(1000);assert.equal((await a.call('/api/messages/'+latest+'/delete',{confirm:true})).status,200);
  const deletedAt=f.now();f.advance(1000);await f.send(b,ab,'검색과 무관한 최신 대화');
  const match=(await admin(rooms+'?member='+a.id+'&q='+query(longQuery))).body[0];
  assert.equal(match.id,ab);assert.equal(match.matchingMessages,1);assert.equal(match.matchSnippet,longQuery);
  assert.equal(Array.from(match.matchSnippet).length,200);assert.equal(match.matchDeletedAt,deletedAt);
  assert.equal(match.matchSent,sent);assert.equal(match.recent,f.now());
  const partial=(await admin(rooms+'?q='+query('찾찾찾'))).body[0].matchSnippet;
  assert.ok(partial.includes('찾찾찾'));assert.ok(partial.startsWith('앞'));assert.ok(Array.from(partial).length<=200);
  const old=(await admin(rooms+'/'+ab+'/messages?q='+query(longQuery))).body;
  assert.equal(old.length,1);assert.equal(old[0].id,latest);assert.equal(old[0].deleted,true);assert.equal(old[0].body,body);
  await f.send(a,ac,'İ'.repeat(300)+'😀'.repeat(20)+longQuery+'뒤'.repeat(400));
  assert.equal((await admin(rooms+'?member='+c.id+'&q='+query(longQuery))).body[0].matchSnippet,longQuery);
});

test('search retains administrator-readable deletion and report originals but excludes removed and expired content',async t=>{
  const f=fixture(t),a=await f.member('작성 회원'),b=await f.member('검토 회원'),admin=await f.admin(),room=await f.room(a,b);
  const retained=await f.send(a,room,'공통검색 삭제된 원문'),removed=await f.send(a,room,'공통검색 REMOVED_SECRET');
  const reported=await f.send(a,room,'공통검색 신고 검토 원문');
  assert.equal((await a.call('/api/messages/'+retained+'/delete',{confirm:true})).status,200);
  // A legacy removed row may retain bytes, but presentMessage still hides it.
  f.db.prepare("INSERT INTO reviews VALUES(?,'removed')").run(removed);
  assert.equal((await b.call('/api/report',{kind:'message',message:reported,reason:'괴롭힘·기타 위반'})).status,200);
  const expired=f.db.prepare('INSERT INTO messages(room,author,sent,body,photo,expires) VALUES(?,?,?,?,?,?)')
    .run(room,a.id,f.now()-24*hour,'공통검색 EXPIRED_SECRET',Buffer.from([255,216,255,217]),f.now()).lastInsertRowid;
  f.db.prepare("INSERT INTO reviews VALUES(?,'approved')").run(expired);
  f.db.prepare('INSERT INTO messages(room,author,sent,body) VALUES(?,?,?,?)')
    .run(room,b.id,f.now()-24*hour,'공통검색 EXPIRED_TEXT_SECRET');
  assert.equal((await b.call('/api/rooms/'+room+'/leave',{confirm:true})).status,200);
  const results=(await admin(rooms+'/'+room+'/messages?q='+query('공통검색'))).body;
  assert.deepEqual(results.map(message=>message.id),[retained,reported]);
  for(const message of results){assert.equal(message.visibility,'visible');assert.equal(message.deleted,true);assert.ok(message.body);}
  const roomResult=(await admin(rooms+'?q='+query('공통검색'))).body[0];
  assert.equal(roomResult.matchingMessages,2);assert.ok(roomResult.matchSnippet.includes('신고 검토 원문'));
  assert.equal(roomResult.closedReason,'left');
  for(const secret of ['REMOVED_SECRET','EXPIRED_SECRET','EXPIRED_TEXT_SECRET']){
    assert.deepEqual((await admin(profiles+'?q='+secret)).body,[]);
    assert.deepEqual((await admin(rooms+'?q='+secret)).body,[]);
    assert.deepEqual((await admin(rooms+'/'+room+'/messages?q='+secret)).body,[]);
  }
  assert.equal((await a.call('/api/rooms/'+room+'/messages')).status,404);
});

test('admin search filters all historical messages before applying sixty-row cursor pagination',async t=>{
  const f=fixture(t),a=await f.member('과거 발신'),b=await f.member('과거 수신'),c=await f.member('다른 대화'),admin=await f.admin();
  const room=await f.room(a,b),other=await f.room(a,c),ids=[];
  const insert=f.db.prepare('INSERT INTO messages(room,author,sent,body) VALUES(?,?,?,?)');
  for(let i=0;i<125;i++)ids.push(Number(insert.run(room,a.id,f.now()+i,'Archive Match '+i).lastInsertRowid));
  for(let i=0;i<80;i++)insert.run(room,b.id,f.now()+200+i,'최근의 무관한 대화 '+i);
  insert.run(other,c.id,f.now()+500,'Archive Match 다른 방');
  assert.equal((await admin(rooms+'/'+room+'/messages')).body.every(message=>!message.body.includes('Archive')),true);
  const found=[];let before;
  for(const size of [60,60,5]){
    const result=await admin(rooms+'/'+room+'/messages?q='+query('archive match')+(before?'&before='+before:''));
    assert.equal(result.status,200);assert.equal(result.body.length,size);
    assert.equal(result.body.every(message=>message.room===room&&message.visibility==='visible'),true);
    found.push(...result.body.map(message=>message.id));before=result.body[0].id;
  }
  assert.deepEqual(found.sort((a,b)=>a-b),ids);assert.equal(new Set(found).size,125);
  assert.deepEqual((await admin(rooms+'/'+room+'/messages?q='+query('archive match')+'&before='+before)).body,[]);
  const result=(await admin(rooms+'?member='+b.id+'&q='+query('archive match'))).body;
  assert.equal(result.length,1);assert.equal(result[0].matchingMessages,125);
  assert.equal(result[0].matchSnippet,'Archive Match 124');
  await f.consistent(admin,'archive match');
});

test('monitor and message search preserve administrator authentication and reject malformed query scopes',async t=>{
  const f=fixture(t),a=await f.member('권한 회원'),b=await f.member('상대 회원'),admin=await f.admin(),anonymous=f.client();
  const room=await f.room(a,b);await f.send(a,room,'권한 검색');
  const paths=[profiles,rooms+'?member='+a.id,rooms+'/'+room+'/messages?q='+query('권한')];
  for(const path of paths)for(const call of [anonymous,a.call])assert.equal((await call(path)).status,401);
  for(const path of [profiles+'?q='+query('a'.repeat(201)),rooms+'?q='+query('a'.repeat(201)),rooms+'/'+room+'/messages?q='+query('a'.repeat(201)),
    profiles+'?area=unknown',rooms+'?area=unknown',rooms+'?member=',rooms+'?member=not-a-uuid',rooms+'/'+room+'/messages?q=test&before=bad'])
    assert.equal((await admin(path)).status,400,path);
  assert.equal((await admin(rooms+'?member='+randomUUID())).status,404);
  assert.deepEqual((await admin(profiles+'?q=%20%20')).body,(await admin(profiles)).body);
  assert.equal((await a.call('/api/rooms/'+room+'/messages?q='+query('권한'))).status,400);
  const stranger=await f.member('권한 없는 회원');assert.equal((await stranger.call('/api/rooms/'+room+'/messages?q='+query('권한'))).status,404);
  const count=f.checks.length;assert.equal((await admin(profiles)).status,200);assert.equal(f.checks.length,count+1);
  f.approved(false);assert.equal((await admin(profiles)).status,401);assert.equal((await admin(rooms+'?q='+query('권한'))).status,401);
});
