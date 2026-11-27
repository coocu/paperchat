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

const path='/api/admin/members',day=24*hour;
const region=area=>'area='+encodeURIComponent(area);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-member-regions-')),origin='https://paperchat.example';
  let now=Date.UTC(2026,10,28),approved=true,checks=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const server=makeServer({dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}},
  {async check(){checks++;return {status:approved?'approved':'expired',token:'test-token'};}});
  const db=openStore(dir);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    return async(url,body)=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=url;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin,'user-agent':'test-browser',
        cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(key){return headers[key.toLowerCase()];},setHeader(key,value){headers[key.toLowerCase()]=value;},
          writeHead(status,values){this.status=status;for(const [key,value]of Object.entries(values||{}))this.setHeader(key,value);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(error){reject(error);}
      });
    };
  }
  async function member(nick,area='서울 동부') {
    const call=client();
    assert.equal((await call('/api/key',{code:'shared-member-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area,memo:'지역별 가입자 현황 확인',policy:policyVersion})).status,200);
    return {call,id:(await call('/api/state')).body.profile.id};
  }
  async function admin(){const call=client();assert.equal((await call('/api/admin/login',{key:'codenote-regions-kyh'})).status,200);return call;}
  function seed(nick,area,lastSeen=now) {
    const id=randomUUID();
    db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)')
      .run(id,id,nick,1995,'여성',area,'가입자 현황 테스트');
    db.prepare('INSERT INTO member_activity VALUES(?,?)').run(id,lastSeen);
    return id;
  }
  return {db,client,member,admin,seed,now:()=>now,advance(ms){now+=ms;},checks:()=>checks,approved(value){approved=value;}};
}

test('regional member lists and counts use the same normalized area while global withdrawals remain unchanged',async t=>{
  const f=fixture(t),a=await f.member('서울 첫 회원'),b=await f.member('서울 미접속'),c=await f.member('부산 미접속','부산 전체');
  const departed=await f.member('탈퇴한 회원','경기 북부'),admin=await f.admin();
  assert.equal((await departed.call('/api/withdraw',{confirm:true})).status,200);
  f.db.prepare('UPDATE member_activity SET last_seen=? WHERE member IN (?,?)').run(f.now()-30*day,b.id,c.id);
  const global=(await admin(path)).body;
  assert.deepEqual(global.counts,{active:3,inactive:2,withdrawn:1});
  assert.deepEqual(global.items.map(member=>member.id).sort(),[a.id,b.id,c.id,departed.id].sort());
  const activity=f.db.prepare('SELECT * FROM member_activity ORDER BY member').all();
  const seoul=await admin(path+'?'+region('서울 동부'));
  assert.equal(seoul.status,200);assert.match(seoul.headers['cache-control'],/no-store/);
  assert.deepEqual(seoul.body.counts,{active:2,inactive:1,withdrawn:0});
  assert.deepEqual(seoul.body.items.map(member=>member.id).sort(),[a.id,b.id].sort());
  assert.equal(seoul.body.items.every(member=>member.area==='서울 동부'&&member.status==='active'),true);
  assert.equal(seoul.body.items.find(member=>member.id===a.id).online,true);
  assert.deepEqual((await admin(path+'?'+region('서울특별시 광진구'))).body,seoul.body);
  assert.deepEqual((await admin(path+'?'+region('  서울특별시   동부  '))).body,seoul.body);
  assert.deepEqual((await admin(path+'?filter=active&'+region('서울 동부'))).body,seoul.body);
  const inactive=(await admin(path+'?filter=inactive&'+region('서울 동부'))).body;
  assert.deepEqual(inactive.items.map(member=>member.id),[b.id]);assert.deepEqual(inactive.counts,seoul.body.counts);
  const withdrawn=(await admin(path+'?filter=withdrawn&'+region('서울 동부'))).body;
  assert.deepEqual(withdrawn.items,[]);assert.equal(withdrawn.more,false);assert.deepEqual(withdrawn.counts,seoul.body.counts);
  assert.deepEqual((await admin(path+'?filter=withdrawn')).body.items.map(member=>member.id),[departed.id]);
  assert.deepEqual((await admin(path+'?'+region('제주 전체'))).body,{items:[],more:false,counts:{active:0,inactive:0,withdrawn:0}});
  assert.deepEqual((await admin(path)).body,global);
  assert.deepEqual(f.db.prepare('SELECT * FROM member_activity ORDER BY member').all(),activity);
});

test('region filtering precedes fifty-row pagination and administrator deletion updates regional totals',async t=>{
  const f=fixture(t),admin=await f.admin(),seoul=[];
  for(let n=0;n<53;n++)seoul.push(f.seed('서울'+String(n).padStart(2,'0'),'서울 동부',f.now()-31*day+n));
  const recent=f.seed('최근 회원','서울 동부');
  for(let n=0;n<15;n++)f.seed('다른 지역'+n,'부산 전체',f.now()-31*day);
  const url=path+'?'+region('서울 동부'),first=(await admin(url)).body,second=(await admin(url+'&offset=50')).body;
  assert.equal(first.items.length,50);assert.equal(first.more,true);assert.equal(second.items.length,4);assert.equal(second.more,false);
  assert.deepEqual(first.counts,{active:54,inactive:53,withdrawn:0});assert.deepEqual(second.counts,first.counts);
  assert.deepEqual([...first.items,...second.items].map(member=>member.id).sort(),[...seoul,recent].sort());
  const inactiveFirst=(await admin(url+'&filter=inactive')).body,inactiveSecond=(await admin(url+'&filter=inactive&offset=50')).body;
  assert.deepEqual(inactiveFirst.items.map(member=>member.id),seoul.slice(0,50));
  assert.deepEqual(inactiveSecond.items.map(member=>member.id),seoul.slice(50));assert.equal(inactiveSecond.more,false);
  assert.equal((await admin(path+'/'+seoul[0]+'/delete',{confirm:true})).status,200);
  const after=(await admin(url)).body;
  assert.deepEqual(after.counts,{active:53,inactive:52,withdrawn:0});assert.equal(after.items.some(member=>member.id===seoul[0]),false);
  assert.deepEqual((await admin(path+'?'+region('부산 전체'))).body.counts,{active:15,inactive:15,withdrawn:0});
  assert.deepEqual((await admin(path)).body.counts,{active:68,inactive:67,withdrawn:1});
  const departed=(await admin(path+'/'+seoul[0])).body;
  assert.deepEqual(departed,{nick:'서울00',withdrawn:f.now(),expires:f.now()+day,status:'withdrawn'});
  assert.equal(f.db.prepare('SELECT 1 FROM members WHERE id=?').get(seoul[0]),undefined);
  assert.deepEqual((await admin(path+'?filter=withdrawn')).body.items.map(member=>member.id),[seoul[0]]);
  assert.deepEqual((await admin(url+'&filter=withdrawn')).body.items,[]);
  assert.equal((await admin(path+'/'+seoul[0]+'/delete',{confirm:true})).status,200);
  assert.deepEqual((await admin(url)).body.counts,after.counts);
  assert.deepEqual((await admin(url+'&offset=1000')).body,{items:[],more:false,counts:after.counts});
});

test('regional inactivity keeps the exact thirty-day boundary and current profile edits move the member between areas',async t=>{
  const f=fixture(t),member=await f.member('지역 이동 회원'),admin=await f.admin();
  const before=f.seed('경계 직전','서울 동부',f.now()-30*day+1),boundary=f.seed('경계 도달','서울 동부',f.now()-30*day);
  f.seed('다른 지역 경계','경기 북부',f.now()-30*day);
  const url=path+'?filter=inactive&'+region('서울 동부');
  assert.deepEqual((await admin(url)).body.items.map(member=>member.id),[boundary]);
  f.advance(1);assert.deepEqual((await admin(url)).body.items.map(member=>member.id),[boundary,before]);
  assert.equal((await member.call('/api/profile',{area:'경기 북부',memo:'지역을 변경한 소개글'})).status,200);
  assert.deepEqual((await admin(path+'?'+region('서울 동부'))).body.counts,{active:2,inactive:2,withdrawn:0});
  const moved=(await admin(path+'?'+region('경기도 고양시'))).body;
  assert.deepEqual(moved.counts,{active:2,inactive:1,withdrawn:0});assert.ok(moved.items.some(item=>item.id===member.id));
});

test('regional member queries preserve administrator authorization, approval checks and parameter validation',async t=>{
  const f=fixture(t),url=path+'?'+region('서울 동부'),anonymous=f.client(),gate=f.client();
  assert.equal((await anonymous(url)).status,401);await gate('/api/key',{code:'shared-member-key'});
  assert.equal((await gate(url)).status,401);
  const member=await f.member('일반 회원');assert.equal((await member.call(url)).status,401);
  const admin=await f.admin(),checks=f.checks();
  assert.equal((await admin(url)).status,200);assert.equal(f.checks(),checks+1);
  for(const area of ['', '서울 전체','지역 미선택',"서울 동부' OR 1=1 --",'없는 지역'])
    assert.equal((await admin(path+'?'+region(area))).status,400,area);
  for(const tail of ['&offset=-1','&offset=1.5','&offset=9007199254740992','&offset=abc','&filter=missing'])
    assert.equal((await admin(url+tail)).status,400,tail);
  f.approved(false);assert.equal((await admin(url)).status,401);assert.equal((await admin(path)).status,401);
});
