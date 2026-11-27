import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { makeServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { policyVersion } from '../public/rules.js';

const publicPath='/api/announcement',adminPath='/api/admin/announcement';
const defaults={enabled:false,title:'공지',body:'',androidEnabled:true,iosEnabled:true,androidUrl:'',iosUrl:''};
const announcement={enabled:true,title:'업데이트 안내',body:'새 버전을 확인해 주세요.\n두 번째 줄',
  androidEnabled:true,iosEnabled:false,androidUrl:'https://downloads.example/android.apk',iosUrl:'https://apps.apple.com/app/id123456'};

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-announcement-')),origin='https://paperchat.example';
  const adminKey='codenote-announcement-kyh',lookups=[];
  let approved=true;
  const upstream={async check(code){lookups.push(code);return {status:approved?'approved':'expired',token:'test-token'};}};
  const config={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}};
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  let server=makeServer(config,upstream);
  const db=openStore(dir);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    const call=async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=options.method||(body===undefined?'GET':'POST');req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin??origin,'user-agent':'test-browser',
        cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(k){return headers[k.toLowerCase()];},setHeader(k,v){headers[k.toLowerCase()]=v;},
          writeHead(status,h){this.status=status;for(const [k,v]of Object.entries(h||{}))this.setHeader(k,v);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(e){reject(e);}
      });
    };
    return call;
  }
  async function admin(call=client()) {
    assert.equal((await call('/api/admin/login',{key:adminKey})).status,200);return call;
  }
  async function member() {
    const call=client();
    assert.equal((await call('/api/key',{code:'member-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick:'공지 회원',birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area:'서울 동부',memo:'소개글',policy:policyVersion})).status,200);
    return call;
  }
  return {db,client,admin,member,adminKey,lookups,setApproved(value){approved=value;},
    restart(){server.emit('close');server=makeServer(config,upstream);}};
}

test('public announcement has seven default fields, no-store and no write side effects',async t=>{
  const f=fixture(t),publicClient=f.client();
  const response=await publicClient(publicPath);
  assert.equal(response.status,200);assert.deepEqual(response.body,defaults);
  assert.equal(Object.keys(response.body).length,7);assert.match(response.headers['cache-control'],/no-store/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,0);
  assert.equal((await publicClient(publicPath,announcement)).status,404);
  assert.equal((await publicClient(publicPath,undefined,{method:'DELETE'})).status,405);
  const admin=await f.admin();assert.deepEqual((await admin(adminPath)).body,defaults);
});

test('announcement writes require administrator approval and same-origin POST, while reads stay public',async t=>{
  const f=fixture(t),anonymous=f.client(),member=await f.member(),admin=await f.admin();
  for(const call of [anonymous,member]) {
    assert.equal((await call(adminPath)).status,401);
    assert.equal((await call(adminPath,announcement)).status,401);
  }
  for(const origin of ['https://attacker.example',''])
    assert.equal((await admin(adminPath,announcement,{origin})).status,403);
  assert.deepEqual((await anonymous(publicPath)).body,defaults);
  let checked=f.lookups.length;
  assert.equal((await admin(adminPath,announcement)).status,200);assert.equal(f.lookups.length,checked+1);
  checked=f.lookups.length;
  assert.equal((await admin(adminPath)).status,200);assert.equal(f.lookups.length,checked+1);
  f.setApproved(false);
  assert.equal((await admin(adminPath)).status,401);
  assert.equal((await admin(adminPath,{...announcement,title:'변경 시도'})).status,401);
  assert.deepEqual((await member(publicPath)).body,announcement);
  f.setApproved(true);await f.admin(admin);f.setApproved(false);
  assert.equal((await admin(adminPath,{...announcement,title:'승인 만료 변경'})).status,401);
  assert.deepEqual((await anonymous(publicPath)).body,announcement);
});

test('announcement and existing download APIs share addresses while retaining other settings',async t=>{
  const f=fixture(t),admin=await f.admin(),publicClient=f.client();
  assert.equal((await admin('/api/admin/settings',{url:'https://forms.example/join'})).status,200);
  const links={androidUrl:'https://old.example/android',iosUrl:'https://old.example/iphone'};
  assert.equal((await admin('/api/admin/download-links',links)).status,200);
  assert.deepEqual((await publicClient(publicPath)).body,{...defaults,...links});
  const input={...announcement,title:'  제목  ',body:'  첫 줄\n\n다음 줄  ',androidUrl:'  https://DOWNLOADS.EXAMPLE/android  ',iosUrl:'   '};
  const expected={...announcement,title:'제목',body:'첫 줄\n\n다음 줄',androidUrl:'https://downloads.example/android',iosUrl:''};
  const response=await admin(adminPath,input);assert.equal(response.status,200);assert.deepEqual(response.body,expected);
  assert.deepEqual((await publicClient('/api/download-links')).body,{androidUrl:expected.androidUrl,iosUrl:''});
  assert.deepEqual((await admin('/api/admin/download-links')).body,{androidUrl:expected.androidUrl,iosUrl:''});
  assert.deepEqual((await admin('/api/admin/settings')).body,{url:'https://forms.example/join'});
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE name='download_ios'").get(),undefined);
  const stored=JSON.parse(f.db.prepare("SELECT value FROM settings WHERE name='announcement'").get().value);
  assert.deepEqual(Object.keys(stored).sort(),['androidEnabled','body','enabled','iosEnabled','title']);
  assert.equal((await admin('/api/admin/download-links',{androidUrl:'',iosUrl:'https://new.example/ios'})).status,200);
  assert.deepEqual((await publicClient(publicPath)).body,{...expected,androidUrl:'',iosUrl:'https://new.example/ios'});
  const hidden={...announcement,enabled:false,androidEnabled:false,iosEnabled:false};
  assert.equal((await admin(adminPath,hidden)).status,200);
  assert.deepEqual((await publicClient('/api/download-links')).body,{androidUrl:announcement.androidUrl,iosUrl:announcement.iosUrl});
  assert.deepEqual((await publicClient(publicPath)).body,hidden);
});

test('all seven fields are required with strict types and lengths; invalid mixed updates are atomic',async t=>{
  const f=fixture(t),admin=await f.admin(),publicClient=f.client();
  assert.equal((await admin(adminPath,announcement)).status,200);
  const invalid=[{...announcement,extra:true}];
  for(const key of Object.keys(announcement)) {
    const missing={...announcement};delete missing[key];invalid.push(missing);
  }
  for(const key of ['enabled','androidEnabled','iosEnabled'])for(const value of [0,1,'true',null])invalid.push({...announcement,[key]:value});
  for(const key of ['title','body','androidUrl','iosUrl'])for(const value of [0,null,[],{}])invalid.push({...announcement,[key]:value});
  for(const title of ['','  ','x'.repeat(121)])invalid.push({...announcement,title});
  for(const body of ['','\n\t','x'.repeat(20001)])invalid.push({...announcement,body});
  for(const url of ['http://downloads.example/app','javascript:alert(1)','https://user:password@downloads.example/app',
    'not a URL','https://','https://downloads.example/\nfile','https://downloads.example/'+ 'x'.repeat(2048)]) {
    invalid.push({...announcement,title:'반영되면 안 되는 제목',androidUrl:'https://new.example/android',iosUrl:url});
    invalid.push({...announcement,title:'반영되면 안 되는 제목',androidUrl:url,iosUrl:'https://new.example/ios'});
  }
  for(const input of invalid) {
    assert.equal((await admin(adminPath,input)).status,400);
    assert.deepEqual((await publicClient(publicPath)).body,announcement);
  }
  const maximum={...announcement,title:'가'.repeat(120),body:'나'.repeat(20000)};
  assert.equal((await admin(adminPath,maximum)).status,200);
  assert.deepEqual((await admin(adminPath)).body,maximum);
  const blank={enabled:false,title:'  ',body:' \n ',androidEnabled:false,iosEnabled:false,androidUrl:' ',iosUrl:''};
  assert.equal((await admin(adminPath,blank)).status,200);
  assert.deepEqual((await admin(adminPath)).body,{...blank,title:'',body:'',androidUrl:''});
});

test('a storage failure rolls back the announcement and both download addresses together',async t=>{
  const f=fixture(t),admin=await f.admin(),publicClient=f.client();
  assert.equal((await admin(adminPath,announcement)).status,200);
  // The final address write fails after the announcement and Android writes.
  // This verifies rollback, in addition to validating everything before writes.
  f.db.exec(`CREATE TRIGGER reject_announcement_ios BEFORE INSERT ON settings
    WHEN NEW.name='download_ios' BEGIN SELECT RAISE(ABORT,'test write failure'); END`);
  t.mock.method(console,'error',()=>{});
  const changed={...announcement,title:'저장 실패',androidUrl:'https://new.example/android',iosUrl:'https://new.example/ios'};
  assert.equal((await admin(adminPath,changed)).status,500);
  assert.deepEqual((await publicClient(publicPath)).body,announcement);
  assert.deepEqual((await publicClient('/api/download-links')).body,{androidUrl:announcement.androidUrl,iosUrl:announcement.iosUrl});
});

test('announcement survives restart and administrator reset restores defaults and clears shared addresses',async t=>{
  const f=fixture(t),admin=await f.admin(),publicClient=f.client(),member=await f.member();
  const before=(await member('/api/state')).body.profile;
  assert.equal((await admin(adminPath,announcement)).status,200);
  assert.equal((await admin('/api/admin/settings',{url:'https://forms.example/join'})).status,200);
  f.restart();
  assert.deepEqual((await publicClient(publicPath)).body,announcement);
  assert.deepEqual((await admin(adminPath)).body,announcement);
  assert.deepEqual((await member('/api/state')).body.profile,before);
  assert.deepEqual((await admin('/api/admin/settings')).body,{url:'https://forms.example/join'});
  assert.equal((await admin('/api/admin/reset',{key:f.adminKey,confirm:'전체 삭제'})).status,200);
  assert.deepEqual((await publicClient(publicPath)).body,defaults);
  assert.deepEqual((await publicClient('/api/download-links')).body,{androidUrl:'',iosUrl:''});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,0);
  assert.equal((await member('/api/state')).body.stage,'gate');
  f.restart();assert.deepEqual((await publicClient(publicPath)).body,defaults);
});
