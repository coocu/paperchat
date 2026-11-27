import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { makeServer } from '../server.mjs';
import { openStore,hour } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { policyVersion } from '../public/rules.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-profile-detail-')),origin='https://paperchat.example';
  let now=Date.UTC(2026,10,27,0,0,0);
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const server=makeServer({dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}},
  {async check(){return {status:'approved',token:'test-token'};}});
  const db=openStore(dir),safety=moderation(db);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    return async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin,'user-agent':'test-browser',
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
  }
  async function member(nick,area='서울 동부') {
    const call=client();
    assert.equal((await call('/api/key',{code:'member-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area,memo:'처음 소개글',policy:policyVersion})).status,200);
    const {profile}=(await call('/api/state')).body;
    return {id:profile.id,call,identity:db.prepare('SELECT identity FROM members WHERE id=?').get(profile.id).identity};
  }
  const path=id=>'/api/people/'+id;
  async function hidden(from,to) {
    assert.equal((await from.call(path(to.id))).status,404);
    assert.equal((await from.call('/api/people')).body.some(member=>member.id===to.id),false);
  }
  return {db,safety,client,member,path,hidden,now:()=>now,advance(ms){now+=ms;}};
}

test('individual profile matches the public list fields and activity without changing last seen',async t=>{
  const f=fixture(t),a=await f.member('보는 회원'),b=await f.member('상대 회원','경기 북부');
  const expected=(await a.call('/api/people')).body.find(member=>member.id===b.id);
  const response=await a.call(f.path(b.id));
  assert.equal(response.status,200);assert.deepEqual(response.body,expected);assert.match(response.headers['cache-control'],/no-store/);
  assert.deepEqual(Object.keys(response.body).sort(),['area','gender','id','lastSeen','memo','nick','online','profileVersion','year']);
  assert.equal(response.body.online,true);
  const activity=f.db.prepare('SELECT * FROM member_activity ORDER BY member').all();
  f.advance(90000);const later=await a.call(f.path(b.id));
  assert.equal(later.status,200);assert.equal(later.body.online,false);assert.equal(later.body.lastSeen,expected.lastSeen);
  assert.deepEqual(f.db.prepare('SELECT * FROM member_activity ORDER BY member').all(),activity);
  assert.equal((await a.call('/api/people?area='+encodeURIComponent('서울 동부'))).body.some(member=>member.id===b.id),false);
  assert.equal((await a.call(f.path(b.id))).status,200);
});

test('profile detail requires a current member and honors policy, restrictions and account binding',async t=>{
  const f=fixture(t),a=await f.member('현재 계정'),b=await f.member('상대 계정'),anonymous=f.client();
  assert.equal((await anonymous(f.path(b.id))).status,401);
  const gate=f.client();await gate('/api/key',{code:'member-key'});
  assert.equal((await gate(f.path(b.id))).status,401);
  const admin=f.client();await admin('/api/admin/login',{key:'codenote-profile-kyh'});
  assert.equal((await admin(f.path(b.id))).status,401);
  const stale=await a.call(f.path(b.id),undefined,{headers:{'x-paperchat-member':b.id}});
  assert.equal(stale.status,409);assert.equal(stale.body.code,'ACCOUNT_CHANGED');
  assert.equal((await a.call(f.path(b.id),undefined,{headers:{'x-paperchat-member':a.id}})).status,200);
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(a.id);
  assert.equal((await a.call(f.path(b.id))).status,403);f.safety.accept(a.id,policyVersion);
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(a.identity,f.now()+hour);
  assert.equal((await a.call(f.path(b.id))).status,403);
  f.db.prepare('DELETE FROM restrictions WHERE identity=?').run(a.identity);
  f.db.prepare('UPDATE sessions SET expires=? WHERE member=?').run(f.now(),a.id);
  assert.equal((await a.call(f.path(b.id))).status,401);
});

test('self, missing, blocked, restricted and deleted profiles follow the same visibility as the list',async t=>{
  const f=fixture(t),a=await f.member('첫 회원'),b=await f.member('둘째 회원');
  await f.hidden(a,a);
  for(const id of [randomUUID(),'invalid-id',"' OR 1=1"])
    assert.equal((await a.call(f.path(encodeURIComponent(id)))).status,404);
  assert.equal((await a.call(f.path(b.id),{})).status,404);
  for(const [owner,peer]of [[a,b],[b,a]]) {
    assert.equal((await owner.call('/api/blocks',{peer:peer.id})).status,200);
    await f.hidden(a,b);await f.hidden(b,a);
    assert.equal((await owner.call('/api/blocks',{peer:peer.id,remove:true})).status,200);
    assert.equal((await a.call(f.path(b.id))).status,200);
  }
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(b.identity,f.now()+1000);
  await f.hidden(a,b);f.advance(1000);assert.equal((await a.call(f.path(b.id))).status,200);
  const admin=f.client();assert.equal((await admin('/api/admin/login',{key:'codenote-profile-kyh'})).status,200);
  assert.equal((await admin('/api/admin/members/'+b.id+'/delete',{confirm:true})).status,200);
  await f.hidden(a,b);assert.equal((await b.call(f.path(a.id))).status,401);
});

test('profile detail reflects edits immediately and returns the current report version',async t=>{
  const f=fixture(t),a=await f.member('읽는 회원'),b=await f.member('편집 회원');
  const before=(await a.call(f.path(b.id))).body;
  assert.equal((await b.call('/api/profile',{area:'경기 북부',memo:before.memo})).status,200);
  const areaOnly=(await a.call(f.path(b.id))).body;
  assert.equal(areaOnly.area,'경기 북부');assert.equal(areaOnly.profileVersion,before.profileVersion);
  assert.equal((await b.call('/api/profile',{area:'부산 전체',memo:'수정한 최신 소개글\n두 번째 줄'})).status,200);
  const after=(await a.call(f.path(b.id))).body;
  assert.equal(after.area,'부산 전체');assert.equal(after.memo,'수정한 최신 소개글\n두 번째 줄');
  assert.notEqual(after.profileVersion,before.profileVersion);
  for(const key of ['id','nick','year','gender'])assert.equal(after[key],before[key]);
  assert.deepEqual(after,(await a.call('/api/people')).body.find(member=>member.id===b.id));
  const profile=(await b.call('/api/state')).body.profile;
  for(const key of Object.keys(profile))assert.equal(after[key],profile[key]);
  assert.equal((await a.call('/api/report',{kind:'profile',peer:b.id,profileVersion:before.profileVersion,reason:'괴롭힘·기타 위반'})).status,409);
  assert.equal((await a.call('/api/report',{kind:'profile',peer:b.id,profileVersion:after.profileVersion,reason:'괴롭힘·기타 위반'})).status,200);
  const report=f.db.prepare('SELECT content,profile_snapshot FROM reports WHERE target=?').get(b.id);
  assert.equal(report.content,after.profileVersion);assert.equal(JSON.parse(report.profile_snapshot).memo,after.memo);
});
