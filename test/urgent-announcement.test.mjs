import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { makeServer } from '../server.mjs';
import { openStore,hour } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { policyVersion } from '../public/rules.js';

const path='/api/urgent-announcement',adminPath='/api/admin/urgent-announcement';
const defaults={enabled:false,title:'긴급공지',body:'',revision:null,publishedAt:null};
const notice={enabled:true,title:'긴급 안내',body:'잠시 후 점검을 시작합니다.\n확인해 주세요.'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-urgent-')),origin='https://paperchat.example',adminKey='codenote-urgent-kyh';
  let now=Date.UTC(2026,10,27,0,0,0),approved=true;
  const checks=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const config={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}};
  const upstream={async check(code){checks.push(code);return {status:approved?'approved':'expired',token:'test-token'};}};
  let server=makeServer(config,upstream);
  const db=openStore(dir),safety=moderation(db);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    const call=async(url,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=url;req.socket={remoteAddress:randomUUID()};
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
    assert.equal((await call('/api/key',{code:'member-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area:'서울 동부',memo:'소개글',policy:policyVersion})).status,200);
    const {profile}=(await call('/api/state')).body,{code}=(await call('/api/account/recovery')).body;
    return {id:profile.id,call,code,identity:db.prepare('SELECT identity FROM members WHERE id=?').get(profile.id).identity};
  }
  async function admin(call=client()){assert.equal((await call('/api/admin/login',{key:adminKey})).status,200);return call;}
  function events(call) {
    const req=Readable.from([]);req.method='GET';req.url='/api/events';req.socket={remoteAddress:'events'};
    req.headers={cookie:[...call.cookies].map(([k,v])=>k+'='+v).join('; ')};
    const res=new EventEmitter();res.chunks=[];res.headers={};res.writableEnded=false;
    res.setHeader=(k,v)=>res.headers[k.toLowerCase()]=v;res.getHeader=k=>res.headers[k.toLowerCase()];
    res.writeHead=(status,h)=>{res.status=status;res.headersSent=true;for(const [k,v]of Object.entries(h))res.setHeader(k,v);};
    res.write=data=>{res.chunks.push(data);return true;};
    res.end=data=>{if(data)res.chunks.push(data);res.writableEnded=true;res.emit('close');};
    server.emit('request',req,res);
    assert.equal(res.status,200);assert.match(res.headers['content-type'],/text\/event-stream/);
    res.urgent=()=>res.chunks.filter(chunk=>chunk.startsWith('event: urgent-announcement\n'))
      .map(chunk=>JSON.parse(chunk.split('data: ')[1]));
    return res;
  }
  return {db,safety,client,member,admin,adminKey,checks,events,now:()=>now,advance(ms){now+=ms;},
    approved(value){approved=value;},restart(){server.emit('close');server=makeServer(config,upstream);}};
}

test('urgent notice defaults have five fields and only active authenticated members can read them',async t=>{
  const f=fixture(t),a=await f.member('긴급공지 회원'),anonymous=f.client(),admin=await f.admin();
  const response=await a.call(path);assert.equal(response.status,200);assert.deepEqual(response.body,defaults);
  assert.match(response.headers['cache-control'],/no-store/);assert.deepEqual((await admin(adminPath)).body,defaults);
  assert.equal((await anonymous(path)).status,401);assert.equal((await admin(path)).status,401);
  const gate=f.client();await gate('/api/key',{code:'member-key'});assert.equal((await gate(path)).status,401);
  assert.equal((await a.call(path,notice)).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,0);
  const stale=await a.call(path,undefined,{headers:{'x-paperchat-member':randomUUID()}});
  assert.equal(stale.status,409);assert.equal(stale.body.code,'ACCOUNT_CHANGED');
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(a.id);
  assert.equal((await a.call(path)).status,403);f.safety.accept(a.id,policyVersion);
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(a.identity,f.now()+hour);
  assert.equal((await a.call(path)).status,403);f.db.prepare('DELETE FROM restrictions WHERE identity=?').run(a.identity);
  const status=(await a.call('/api/status')).body;
  assert.equal(Object.keys(status).some(key=>/urgent|announcement/i.test(key)),false);
});

test('urgent notice management requires administrator reapproval and same-origin writes',async t=>{
  const f=fixture(t),a=await f.member('일반 회원'),anonymous=f.client(),admin=await f.admin();
  for(const call of [anonymous,a.call]){
    assert.equal((await call(adminPath)).status,401);assert.equal((await call(adminPath,notice)).status,401);
  }
  for(const origin of ['','https://other.example'])assert.equal((await admin(adminPath,notice,{origin})).status,403);
  assert.deepEqual((await a.call(path)).body,defaults);
  let count=f.checks.length;assert.equal((await admin(adminPath)).status,200);assert.equal(f.checks.length,count+1);
  count=f.checks.length;const saved=await admin(adminPath,notice);assert.equal(saved.status,200);assert.equal(f.checks.length,count+1);
  f.approved(false);assert.equal((await admin(adminPath,{...notice,title:'실패한 변경'})).status,401);
  assert.deepEqual((await a.call(path)).body,saved.body);
  f.approved(true);await f.admin(admin);f.approved(false);assert.equal((await admin(adminPath)).status,401);
});

test('every valid save has a fresh revision, publish time follows enabled and invalid changes preserve the previous notice',async t=>{
  const f=fixture(t),a=await f.member('검증 회원'),admin=await f.admin(),stream=f.events(a.call);
  const first=await admin(adminPath,{...notice,title:'  긴급 안내  ',body:'  첫 줄\n두 번째 줄  '});
  assert.equal(first.status,200);assert.equal(first.body.title,'긴급 안내');assert.equal(first.body.body,'첫 줄\n두 번째 줄');
  assert.match(first.body.revision,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert.equal(first.body.publishedAt,f.now());
  assert.deepEqual(Object.keys(first.body).sort(),['body','enabled','publishedAt','revision','title']);
  assert.deepEqual(stream.urgent(),[{revision:first.body.revision}]);
  const invalid=[{...notice,revision:randomUUID()},{...notice,publishedAt:0},{...notice,extra:true}];
  for(const key of ['enabled','title','body']){const missing={...notice};delete missing[key];invalid.push(missing);}
  for(const enabled of [null,1,'true'])invalid.push({...notice,enabled});
  for(const key of ['title','body'])for(const value of [null,1,[],{}])invalid.push({...notice,[key]:value});
  for(const title of ['',' \n ','x'.repeat(121)])invalid.push({...notice,title});
  for(const body of ['','\t\n','x'.repeat(20001)])invalid.push({...notice,body});
  for(const value of invalid){assert.equal((await admin(adminPath,value)).status,400);assert.deepEqual((await a.call(path)).body,first.body);}
  assert.equal(stream.urgent().length,1);
  f.advance(2000);const second=(await admin(adminPath,{...notice,title:'제'.repeat(120),body:'글'.repeat(20000)})).body;
  assert.equal(second.title.length,120);assert.equal(second.body.length,20000);
  assert.notEqual(second.revision,first.body.revision);assert.equal(second.publishedAt,f.now());
  const repeated=(await admin(adminPath,{enabled:second.enabled,title:second.title,body:second.body})).body;
  assert.notEqual(repeated.revision,second.revision);
  const stopped=(await admin(adminPath,{enabled:false,title:' ',body:' \n '})).body;
  assert.deepEqual({...stopped,revision:null},{enabled:false,title:'',body:'',revision:null,publishedAt:null});
  assert.notEqual(stopped.revision,repeated.revision);
  assert.deepEqual(stream.urgent().at(-1),{revision:stopped.revision});assert.deepEqual((await a.call(path)).body,stopped);
});

test('urgent saves are independent of ordinary notices and download settings, survive restart and reset to defaults',async t=>{
  const f=fixture(t),a=await f.member('보존 회원'),admin=await f.admin();
  const ordinary={enabled:true,title:'일반 안내',body:'별도로 보관',androidEnabled:false,iosEnabled:true,
    androidUrl:'https://download.example/android',iosUrl:'https://download.example/ios'};
  assert.equal((await admin('/api/admin/announcement',ordinary)).status,200);
  assert.equal((await admin('/api/admin/settings',{url:'https://forms.example/join'})).status,200);
  const before=f.db.prepare("SELECT * FROM settings WHERE name!='urgent_announcement' ORDER BY name").all();
  const saved=(await admin(adminPath,notice)).body;
  assert.deepEqual(f.db.prepare("SELECT * FROM settings WHERE name!='urgent_announcement' ORDER BY name").all(),before);
  assert.deepEqual((await f.client()('/api/announcement')).body,ordinary);
  assert.equal((await admin('/api/admin/announcement',{...ordinary,enabled:false})).status,200);
  assert.deepEqual((await a.call(path)).body,saved);
  const stream=f.events(a.call);f.restart();assert.equal(stream.writableEnded,true);
  assert.deepEqual((await a.call(path)).body,saved);assert.deepEqual((await admin(adminPath)).body,saved);
  assert.deepEqual((await admin('/api/admin/settings')).body,{url:'https://forms.example/join'});
  const reconnected=f.events(a.call);assert.deepEqual(reconnected.urgent(),[]);
  assert.deepEqual((await a.call(path)).body,saved);
  assert.equal((await admin('/api/admin/reset',{key:f.adminKey,confirm:'전체 삭제'})).status,200);
  assert.equal(reconnected.writableEnded,true);assert.equal((await a.call(path)).status,401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,0);
  const fresh=await f.member('초기화 후 회원');assert.deepEqual((await fresh.call(path)).body,defaults);
  assert.deepEqual((await f.client()('/api/download-links')).body,{androidUrl:'',iosUrl:''});
});

test('SSE broadcasts only revision to every eligible live member session and skips limited or revoked sessions',async t=>{
  const f=fixture(t),members=[];
  for(const nick of ['정상 하나','정상 둘','약관 미동의','제한 회원','만료 회원','로그아웃 회원','삭제 회원'])members.push(await f.member(nick));
  const [a,b,policy,restricted,expired,logout,deleted]=members,admin=await f.admin();
  const streams=members.map(member=>f.events(member.call));
  const another=f.client();assert.equal((await another('/api/account/login',{code:a.code})).status,200);
  const anotherStream=f.events(another);
  assert.equal((await a.call('/api/blocks',{peer:b.id})).status,200);
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(policy.id);
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(restricted.identity,f.now()+hour);
  f.db.prepare('UPDATE sessions SET expires=? WHERE member=?').run(f.now(),expired.id);
  assert.equal((await logout.call('/api/logout',{})).status,200);
  assert.equal((await admin('/api/admin/members/'+deleted.id+'/delete',{confirm:true})).status,200);
  const saved=(await admin(adminPath,notice)).body;
  for(const stream of [streams[0],streams[1],anotherStream])assert.deepEqual(stream.urgent(),[{revision:saved.revision}]);
  for(const stream of streams.slice(2))assert.deepEqual(stream.urgent(),[]);
  for(const stream of streams.slice(4))assert.equal(stream.writableEnded,true);
  for(const member of [policy,restricted])assert.equal((await member.call(path)).status,403);
  for(const member of [expired,logout,deleted])assert.equal((await member.call(path)).status,401);
  for(const stream of [streams[0],streams[1],anotherStream]) {
    assert.equal(Object.keys(stream.urgent()[0]).length,1);
    assert.ok(!stream.chunks.join('').includes(notice.body));assert.ok(!stream.chunks.join('').includes(notice.title));
  }
  streams[1].emit('close');
  const stopped=(await admin(adminPath,{enabled:false,title:notice.title,body:notice.body})).body;
  assert.deepEqual(streams[0].urgent().at(-1),{revision:stopped.revision});assert.equal(streams[1].urgent().length,1);
  assert.deepEqual((await another(path)).body,stopped);
});

test('a failed storage write preserves the previous notice and never broadcasts an unsaved revision',async t=>{
  const f=fixture(t),a=await f.member('저장 실패 검증'),admin=await f.admin(),stream=f.events(a.call);
  const saved=(await admin(adminPath,notice)).body;
  f.db.exec(`CREATE TRIGGER reject_urgent_notice BEFORE INSERT ON settings
    WHEN NEW.name='urgent_announcement' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
  t.mock.method(console,'error',()=>{});
  assert.equal((await admin(adminPath,{...notice,title:'저장하면 안 되는 제목'})).status,500);
  assert.deepEqual((await a.call(path)).body,saved);assert.deepEqual(stream.urgent(),[{revision:saved.revision}]);
});
