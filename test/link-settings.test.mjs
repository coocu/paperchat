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

const path='/api/admin/link-settings',empty={url:'',androidUrl:'',iosUrl:''};
const initial={url:'https://forms.example/join',androidUrl:'https://downloads.example/android',iosUrl:'https://apps.example/iphone'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-link-settings-')),origin='https://paperchat.example',adminKey='codenote-links-kyh';
  let approved=true,checks=0;
  const config={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}};
  const upstream={async check(){checks++;return {status:approved?'approved':'expired',token:'test-token'};}};
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  let server=makeServer(config,upstream);
  const db=openStore(dir);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    return async(url,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=options.method||(body===undefined?'GET':'POST');req.url=url;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin??origin,'user-agent':'test-browser',
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
  async function admin(){const call=client();assert.equal((await call('/api/admin/login',{key:adminKey})).status,200);return call;}
  async function member(){
    const call=client();await call('/api/key',{code:'member-key'});
    await call('/api/profile-details',{nick:'링크 설정 회원',birthDate:'1995-01-03',gender:'여성'});
    assert.equal((await call('/api/register',{area:'서울 동부',memo:'소개글',policy:policyVersion})).status,200);return call;
  }
  return {db,client,admin,member,adminKey,checks:()=>checks,approved(value){approved=value;},
    restart(){server.emit('close');server=makeServer(config,upstream);}};
}

test('combined link settings require current administrator approval and same-origin writes',async t=>{
  const f=fixture(t),anonymous=f.client(),member=await f.member(),admin=await f.admin();
  for(const call of [anonymous,member]){
    assert.equal((await call(path)).status,401);assert.equal((await call(path,initial)).status,401);
  }
  const defaults=await admin(path);assert.equal(defaults.status,200);assert.deepEqual(defaults.body,empty);
  assert.match(defaults.headers['cache-control'],/no-store/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n,0);
  for(const origin of ['https://attacker.example',''])assert.equal((await admin(path,initial,{origin})).status,403);
  let checked=f.checks();assert.equal((await admin(path,initial)).status,200);assert.equal(f.checks(),checked+1);
  checked=f.checks();assert.deepEqual((await admin(path)).body,initial);assert.equal(f.checks(),checked+1);
  assert.equal((await admin(path,undefined,{method:'PUT'})).status,405);
  f.approved(false);assert.equal((await admin(path,{...initial,url:''})).status,401);
  assert.equal((await admin(path)).status,401);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE name='form'").get().value,initial.url);
});

test('combined links share the existing form, download and announcement settings and survive restart',async t=>{
  const f=fixture(t),admin=await f.admin(),publicClient=f.client();
  assert.equal((await admin('/api/admin/settings',{url:initial.url})).status,200);
  assert.equal((await admin('/api/admin/download-links',{androidUrl:initial.androidUrl,iosUrl:initial.iosUrl})).status,200);
  assert.deepEqual((await admin(path)).body,initial);
  const announcement={enabled:true,title:'알림',body:'기존 공지 내용',androidEnabled:false,iosEnabled:true,
    androidUrl:initial.androidUrl,iosUrl:initial.iosUrl};
  assert.equal((await admin('/api/admin/announcement',announcement)).status,200);
  const response=await admin(path,{url:'  https://FORMS.EXAMPLE/new  ',androidUrl:' https://DOWNLOADS.EXAMPLE/new ',iosUrl:'   '});
  const saved={url:'https://forms.example/new',androidUrl:'https://downloads.example/new',iosUrl:''};
  assert.equal(response.status,200);assert.deepEqual(response.body,saved);
  assert.deepEqual((await admin('/api/admin/settings')).body,{url:saved.url});
  for(const endpoint of ['/api/download-links','/api/admin/download-links'])
    assert.deepEqual((await admin(endpoint)).body,{androidUrl:saved.androidUrl,iosUrl:''});
  assert.deepEqual((await publicClient('/api/announcement')).body,{...announcement,androidUrl:saved.androidUrl,iosUrl:''});
  assert.equal((await publicClient('/apply')).headers.location,saved.url);
  f.restart();assert.deepEqual((await admin(path)).body,saved);
  assert.equal((await admin('/api/admin/settings',{url:'https://forms.example/legacy'})).status,200);
  assert.equal((await admin('/api/admin/download-links',{androidUrl:'',iosUrl:'https://apps.example/legacy'})).status,200);
  assert.deepEqual((await admin(path)).body,{url:'https://forms.example/legacy',androidUrl:'',iosUrl:'https://apps.example/legacy'});
  assert.equal((await admin('/api/admin/announcement',announcement)).status,200);
  assert.deepEqual((await admin(path)).body,{...initial,url:'https://forms.example/legacy'});
  const downloadsOnly={url:'',androidUrl:initial.androidUrl,iosUrl:''};
  assert.equal((await admin(path,downloadsOnly)).status,200);assert.deepEqual((await admin(path)).body,downloadsOnly);
  assert.equal(f.db.prepare("SELECT 1 FROM settings WHERE name='form'").get(),undefined);
  assert.equal((await publicClient('/apply')).headers.location,'/?form=unavailable');
  assert.equal((await admin(path,empty)).status,200);assert.deepEqual((await admin(path)).body,empty);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE name IN ('form','download_android','download_ios')").get().n,0);
  assert.deepEqual((await publicClient('/api/announcement')).body,{...announcement,androidUrl:'',iosUrl:''});
});

test('three exact string fields are validated before any link changes, including blank values and URL boundaries',async t=>{
  const f=fixture(t),admin=await f.admin();
  assert.equal((await admin(path,initial)).status,200);
  const invalid=[{...initial,extra:true}];
  for(const key of Object.keys(initial)){
    const missing={...initial};delete missing[key];invalid.push(missing);
    for(const value of [null,1,false,[],{},'http://example.com/app','javascript:alert(1)',
      'https://user:password@example.com/app','https://','not a URL','https://example.com/\napp','https://example.com/'+'x'.repeat(2048)])
      invalid.push({url:'https://changed.example/form',androidUrl:'https://changed.example/android',iosUrl:'https://changed.example/ios',[key]:value});
  }
  for(const input of invalid){assert.equal((await admin(path,input)).status,400);assert.deepEqual((await admin(path)).body,initial);}
  const maximum='https://example.com/'+'x'.repeat(2048-'https://example.com/'.length);
  assert.equal((await admin(path,{url:maximum,androidUrl:maximum,iosUrl:maximum})).status,200);
  assert.equal((await admin(path)).body.url.length,2048);
  assert.equal((await admin(path,{url:'  ',androidUrl:'\n\t',iosUrl:''})).status,200);
  assert.deepEqual((await admin(path)).body,empty);
});

test('a final database write failure rolls back both form updates and form deletion with both download links',async t=>{
  const f=fixture(t),admin=await f.admin();
  assert.equal((await admin(path,initial)).status,200);
  f.db.exec(`CREATE TRIGGER reject_combined_ios BEFORE INSERT ON settings
    WHEN NEW.name='download_ios' BEGIN SELECT RAISE(ABORT,'test write failure'); END`);
  t.mock.method(console,'error',()=>{});
  for(const url of ['https://changed.example/form','']){
    assert.equal((await admin(path,{url,androidUrl:'https://changed.example/android',iosUrl:'https://changed.example/ios'})).status,500);
    assert.deepEqual((await admin(path)).body,initial);
  }
});
