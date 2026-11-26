import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pushQueue } from '../push-queue.mjs';
import { moderation } from '../moderation.mjs';
import { makeServer } from '../server.mjs';
import { policyVersion } from '../public/rules.js';
import { profileDetails,RequestError } from '../providers.mjs';
import { openStore,clean,hour,tables } from '../store.mjs';

test('한국 날짜로 만 19세 생일 전날·당일과 실제 달력의 생년월일을 판정한다',()=>{
  const midnight=Date.parse('2026-11-25T15:00:00Z');
  const details={birthDate:'2007-11-26',gender:'여성'};
  assert.throws(()=>profileDetails(details,midnight-1),/만 19세/);
  assert.deepEqual(profileDetails(details,midnight),{year:2007,gender:'여성'});
  assert.deepEqual(profileDetails({birthDate:'2004-02-29',gender:'남성'},midnight),{year:2004,gender:'남성'});
  for(const birthDate of ['2007-02-29','2000-02-30','2000-13-01','1899-12-31','2030-01-01','1995','',null,1995])
    assert.throws(()=>profileDetails({...details,birthDate},midnight),/생년월일/);
  for(const gender of ['',null,'기타'])assert.throws(()=>profileDetails({...details,gender},midnight),/성별/);
  assert.throws(()=>profileDetails({year:1995,adult:true,gender:'여성'},midnight),/생년월일/);
});
test('인증 게이트, 복원, 지역 대화와 유효기간',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'paperchat-test-'));
  const origin='https://paperchat.example';
  const adminKey='codenote-'+randomBytes(16).toString('hex')+'-kyh';
  const cfg={dir,origin,secret:randomBytes(40).toString('hex')};
  const delivered=[];
  let pushResult='sent';
  cfg.pushProvider={enabled:()=>true,async send(job,event,valid){
    assert.equal(valid(),true);
    if(pushResult==='transient')throw new Error('FCM 503');
    if(pushResult==='sent')delivered.push({token:job.token,event});
    return pushResult;
  }};
  const db=openStore(dir);
  const deliveryQueue=pushQueue(db,cfg.pushProvider,moderation(db));
  t.after(()=>deliveryQueue.close());
  const original=Date.now;let now=original();Date.now=()=>now;
  const recovery=new Map();
  let unblock,started;
  const registry=new Map([[adminKey,{status:'approved',token:'registry-token'}]]);
  const registryLookups=[];
  const providers={
    check:async code=>{
      registryLookups.push(code);
      if(registry.has(code)){
        const answer=registry.get(code);
        if(answer instanceof Error)throw answer;
        return typeof answer==='function' ? answer() : answer;
      }
      if(code==='slow'){started();await new Promise(r=>{unblock=r;});return {status:'approved',token:'ok'};}
      if(code==='blank')return {status:'approved',token:'   '};
      return {status:code.startsWith('invite-')?'approved':code,token:'test-token'};
    }
  };
  let server=makeServer(cfg,providers);
  t.after(()=>{server.emit('close');Date.now=original;db.close();rmSync(dir,{recursive:true,force:true});});
  function client(){
    const cookies=new Map();
    return async function call(path,body,options={}){
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:options.ip||'test-local'};
      req.headers={'content-type':'application/json',origin:options.origin||origin,'user-agent':options.userAgent||'test-browser',cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')};
      const result=await new Promise((done,reject)=>{
        const headers={};
        const res={status:200,getHeader(k){return headers[k.toLowerCase()];},setHeader(k,v){headers[k.toLowerCase()]=v;},writeHead(n,h){this.status=n;Object.entries(h||{}).forEach(([k,v])=>this.setHeader(k,v));},
          end(bytes){const sc=headers['set-cookie'];for(const entry of sc||[]){const [k,v]=entry.split(';')[0].split('=');cookies.set(k,v);}
            const json=headers['content-type']?.startsWith('application/json');done({status:this.status,headers,body:json?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(e){reject(e);}
      });
      return result;
    };
  }
  async function pass(c,nick,account,date){
    if(!nick)return c('/api/account/login',{code:recovery.get(account)},{ip:'login-'+account});
    if((await c('/api/state')).body.stage==='gate'){
      const key=await c('/api/key',{code:'invite-'+randomBytes(12).toString('hex')},{ip:'key-'+account});
      if(key.status!==200)return key;
    }
    return c('/api/profile-details',{nick,birthDate:date||'1995-01-03',gender:'여성'});
  }
  const a=client(),b=client(),c=client(),admin=client(),nobody=client();
  await t.test('앱은 승인된 일반키를 받아 가입 단계만 열고 관리자 로그인은 별도로 검증한다',async()=>{
    for(const prefix of ['invite', 'codenote', 'kyh', 'kyh-codenote']){
      const key=prefix+'-'+randomBytes(12).toString('hex');
      const member=client();
      registry.set(key,{status:'approved',token:'issued'});
      try {
        assert.equal((await member('/api/key',{code:key},{ip:'member-gate'})).status,200);
        assert.equal((await member('/api/state')).body.stage,'gate_ok');
        assert.equal((await member('/api/status')).body.adminSignedIn,false);
        assert.equal((await member('/api/admin/members')).status,401);
        if(prefix!=='kyh-codenote'){
          assert.equal((await member('/api/admin/login',{key},{ip:'member-gate'})).status,403);
          assert.equal((await member('/api/admin/members')).status,401);
        }
      } finally {registry.delete(key);}
    }
  });
  await t.test('진행 중 가입은 한 기기에서 이어가고 사용 이력과 무관하게 발급 서버 승인에 따라 키를 재사용한다',async()=>{
    const code='invite-race', first=client(),second=client();
    await first('/api/state');await second('/api/state');
    let pending=[];
    registry.set(code,()=>new Promise(resolve=>pending.push(resolve)));
    const attempts=[first('/api/key',{code}),second('/api/key',{code})];
    while(pending.length<2)await new Promise(r=>setImmediate(r));
    for(const release of pending)release({status:'approved',token:'once'});
    const result=await Promise.all(attempts);
    assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
    const winner=result[0].status===200?first:second;
    const loser=winner===first?second:first;
    await winner('/api/logout',{});
    assert.equal((await winner('/api/state')).body.stage,'gate_ok');
    assert.equal((await loser('/api/state')).body.stage,'gate');
    registry.set(code,{status:'approved',token:'once'});
    assert.equal((await loser('/api/key',{code})).status,409);
    assert.equal((await winner('/api/profile-details',{nick:'키 재사용 검증',birthDate:'1995-01-01',gender:'여성'})).status,200);
    assert.equal((await winner('/api/register',{area:'경기도 이천시',memo:'검증',policy:policyVersion})).status,200);
    const member=(await winner('/api/state')).body.profile.id;
    registry.set(code,{status:'expired',token:'old'});
    const checked=registryLookups.length;
    assert.equal((await loser('/api/key',{code})).status,403);
    assert.equal(registryLookups.length,checked+1);
    registry.set(code,{status:'approved',token:'reopened'});
    assert.equal((await loser('/api/key',{code})).status,200);
    assert.equal((await loser('/api/state')).body.stage,'gate_ok');
    assert.equal((await loser('/api/key',{code})).status,200);
    assert.equal((await loser('/api/register',{area:'경기도 이천시',memo:'검증',policy:policyVersion})).status,401);
    db.prepare('DELETE FROM members WHERE id=?').run(member);
    registry.delete(code);
  });
  await t.test('서버 첫 화면과 모바일 진입점, 승인 전 운영자 자료 접근을 구분한다',async()=>{
    for(const path of ['/','/admin/','/?inbox=1','/app','/app/','/identity-return']) {
      const r=await nobody(path);assert.equal(r.status,302);assert.equal(r.headers.location,'/admin');
    }
    assert.equal((await nobody('/admin')).status,200);
    for(const userAgent of ['Mobile PaperChatIOS/3','WebView PaperChatAndroid/2','iPhone AppleWebKit/605.1 Mobile/15']){
      assert.equal((await nobody('/app',undefined,{userAgent})).status,200);
      assert.equal((await nobody('/identity-return',undefined,{userAgent})).headers.location,'/app');
      assert.equal((await nobody('/app/?inbox=1',undefined,{userAgent})).headers.location,'/app?inbox=1');
    }
    assert.equal((await nobody('/?inbox=1',undefined,{userAgent:'WebView PaperChatAndroid/2'})).headers.location,'/app?inbox=1');
    for(const path of ['/api/admin/members','/api/admin/review','/api/admin/rooms?area=x','/api/admin/photos/1'])
      assert.equal((await nobody(path,undefined,{userAgent:'WebView PaperChatAndroid/2'})).status,401);
    assert.equal((await nobody('/health')).body.ok,true);
    assert.equal((await nobody('/api/public-info')).body.appName,'종이편지');
  });
  await t.test('미승인, 대기, 토큰 누락과 미성년을 거부한다',async()=>{
    assert.equal((await a('/api/register',{area:'경기도 이천시',memo:'x'})).status,401);
    for(const code of ['pending','invalid','blank'])assert.equal((await a('/api/key',{code})).status,403);
    assert.equal((await pass(c,'어린이','under','2020-01-01')).status,403);
    assert.equal((await c('/api/state')).body.stage,'gate_ok');
    assert.equal((await c('/api/people?area=x')).status,401);
  });
  await t.test('이전 통신사 요청은 계정이나 세션을 만들지 않는다',async()=>{
    for(const path of ['identity/start','identity/finish']){
      assert.equal((await nobody('/api/'+path,{})).status,404);
    }
    assert.equal((await nobody('/api/profile-details',{nick:'회원',birthDate:'1995-01-03',gender:'여성'})).status,401);
  });
  await t.test('키워드 조합만으로 관리자 로그인 불가, 발급 주소 변경 즉시 반영',async()=>{
    assert.equal((await nobody('/api/admin/settings')).status,401);
    assert.equal((await admin('/api/admin/login',{key:'codenote-kyh'})).status,403);
    assert.equal((await admin('/api/admin/login',{key:adminKey})).status,200);
    assert.equal((await admin('/api/admin/settings',{url:'javascript:alert(1)'})).status,400);
    for(const url of ['https://one.example/form','https://two.example/apply']){
      assert.equal((await admin('/api/admin/settings',{url})).status,200);
      assert.equal((await nobody('/apply')).headers.location,url);
    }
  });
  await t.test('하나의 키에 소문자 두 문구와 발급 서버 승인이 모두 필요하다',async()=>{
    const tester=client(), originIp={ip:'key-contract'};
    for(const key of ['codenote','kyh','code-kyh']){
      registry.set(key,{status:'approved',token:'would-approve'});
      const count=registryLookups.length;
      assert.equal((await tester('/api/admin/login',{key},originIp)).status,403);
      assert.equal(registryLookups.length,count);
      registry.delete(key);
    }
    const other='kyh__codenote__'+randomBytes(18).toString('hex');
    for(const answer of [{status:'invalid'},{status:'pending',token:'old'},{status:'approved',token:'  '},null]){
      registry.set(other,answer);
      assert.equal((await tester('/api/admin/login',{key:other},originIp)).status,403);
      assert.equal((await tester('/api/admin/members')).status,401);
    }
    registry.set(other,{status:'approved',token:'active'});
    assert.equal((await tester('/api/admin/login',{key:' '+other+' '},originIp)).status,200);
    assert.equal((await tester('/api/admin/settings')).status,200);
    assert.ok(!readFileSync(join(dir,'chat.sqlite')).includes(Buffer.from(other)));
    registry.set(other,new RequestError(503,'인증 서버 응답 없음'));
    assert.equal((await tester('/api/admin/members')).status,503);
    assert.equal((await tester('/api/admin/reset',{key:other,confirm:'전체 삭제'},originIp)).status,503);
    registry.delete(other);
    assert.equal((await tester('/api/admin/settings',{url:'https://denied.example'})).status,401);
    assert.equal((await tester('/api/status')).body.adminSignedIn,false);
    assert.equal((await admin('/api/admin/settings')).body.url,'https://two.example/apply');
    registry.set(other,{status:'approved',token:'active-again'});
    assert.equal((await tester('/api/admin/members')).status,401);
    registry.delete(other);
  });
  await t.test('발급 서버 확인 중 로그아웃하면 진행 중인 초기화도 취소한다',async()=>{
    const tester=client(), key='codenote-kyh-'+randomBytes(12).toString('hex');
    registry.set(key,{status:'approved',token:'yes'});
    await tester('/api/admin/login',{key},{ip:'reset-race'});
    let release,seen;
    const started=new Promise(r=>seen=r);
    registry.set(key,()=>{seen();return new Promise(r=>release=r);});
    const waiting=tester('/api/admin/reset',{key,confirm:'전체 삭제'},{ip:'reset-race'});
    await started;
    assert.equal((await tester('/api/admin/logout',{})).status,200);
    release({status:'approved',token:'yes'});
    assert.equal((await waiting).status,401);
    assert.equal((await admin('/api/admin/settings')).body.url,'https://two.example/apply');
    registry.delete(key);
  });
  await t.test('동명이인과 같은 일반키가 계정 복구에 쓰이지 않는다',async()=>{
    const guest=client();
    assert.equal((await guest('/api/account/login',{code:'ok'})).status,403);
    assert.equal((await guest('/api/account/login',{code:'가을-1995-여성'})).status,403);
    await guest('/api/key',{code:'invite-nick-test'});
    assert.equal((await guest('/api/profile-details',{nick:'조건만남구함',birthDate:'1995-01-03',gender:'여성'})).status,422);
    assert.equal((await guest('/api/state')).body.stage,'gate_ok');
  });
  await t.test('지역과 메모를 등록하고 재인증해도 기존 프로필이 유지된다',async()=>{
    for(const [client,nick,id,area] of [[a,'가을','DI-A','경기도 이천시'],[b,'겨울','DI-B','서울특별시 중구'],[c,'봄','DI-C','인천광역시 검단구']]){
      assert.equal((await pass(client,nick,id)).body.stage,'details');
      assert.equal((await client('/api/register',{area:'잘못된 지역',policy:policyVersion,memo:'산책'})).status,400);
      assert.equal((await client('/api/register',{area,memo:'산책'})).status,400);
      assert.equal((await client('/api/register',{area,policy:policyVersion,memo:'누드 사진 보내'})).status,422);
      assert.equal((await client('/api/register',{area,policy:policyVersion,memo:'산책'})).status,200);
      const code=(await client('/api/account/recovery')).body.code;
      assert.match(code,/^([A-F0-9]{4}-){7}[A-F0-9]{4}$/);recovery.set(id,code);
      assert.equal((await client('/api/state')).body.needsRecoveryCopy,true);
      assert.equal((await client('/api/account/recovery',{saved:true})).status,200);
      assert.equal((await client('/api/state')).body.needsRecoveryCopy,false);
    }
    const old=(await a('/api/state')).body.profile;
    await a('/api/logout',{});
    assert.equal((await a('/api/state')).body.stage,'gate');
    assert.equal((await pass(a,'','DI-A')).body.stage,'member');
    assert.deepEqual((await a('/api/state')).body.profile,old);
  });
  let room,photo;
  const android={platform:'android',token:'abcd:android-token-for-test'};
  const iphone={platform:'ios-dev',token:'abcd'.repeat(16)};
  await t.test('플랫폼별 발송 설정 상태를 기기 등록과 별개로 조회한다',async()=>{
    const original=cfg.pushProvider.enabled;
    try {
      cfg.pushProvider.enabled=()=>false;
      assert.deepEqual((await nobody('/api/push/availability')).body,{android:false,'ios-dev':false,'ios-prod':false});
      cfg.pushProvider.enabled=p=>p!=='ios-prod';
      assert.deepEqual((await nobody('/api/push/availability')).body,{android:false,'ios-dev':true,'ios-prod':false});
      cfg.pushProvider.androidClient={appId:'test'};
      assert.deepEqual((await nobody('/api/push/availability')).body,{android:true,'ios-dev':true,'ios-prod':false});
    }finally{cfg.pushProvider.enabled=original;delete cfg.pushProvider.androidClient;}
  });
  await t.test('Android 초기 설정은 로그인 전에 조회되며 배포 상태에 맞는 공개 설정만 반환한다',async()=>{
    assert.deepEqual((await nobody('/api/push/android-config')).body,{config:null});
    const clientConfig={projectId:'qa',senderId:'123',appId:'1:123:android:qa',apiKey:'client-key'};
    cfg.pushProvider.androidClient=clientConfig;
    try {
      const response=await nobody('/api/push/android-config');
      assert.equal(response.status,200);
      assert.deepEqual(response.body,{config:clientConfig});
      assert.match(response.headers['cache-control'],/no-store/);
    } finally {delete cfg.pushProvider.androidClient;}
  });
  await t.test('기기 연결은 본인 세션을 요구하며 재등록은 중복되지 않는다',async()=>{
    assert.equal((await nobody('/api/push/device',android)).status,401);
    assert.equal((await a('/api/push/device',{...iphone,token:'wrong'})).status,400);
    for(const [client,device] of [[a,android],[b,iphone],[b,iphone]]) {
      assert.deepEqual((await client('/api/push/device',device)).body,{configured:true});
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_devices').get().n,2);
  });
  await t.test('두 지역에서 관리자 열람, 참여자 외 회원의 대화·사진 차단',async()=>{
    const profile=(await b('/api/state')).body.profile;
    room=(await a('/api/room',{peer:profile.id})).body.id;
    assert.equal((await a('/api/room',{peer:profile.id})).body.id,room);
    const path='/api/rooms/'+room+'/messages';
    assert.equal((await a(path,{body:'반가워요'})).status,200);
    const jpeg=Buffer.from([255,216,255,224,0,0,255,217]).toString('base64');
    assert.equal((await b(path,{photo:jpeg})).status,200);
    await deliveryQueue.flush();assert.deepEqual(delivered.map(d=>d.token),[iphone.token,android.token]);
    const messages=(await a(path)).body;assert.equal(messages.length,2);photo=messages[1].id;
    assert.equal((await a('/api/photos/'+photo)).status,200);
    assert.equal((await a(path)).body[1].visibility,'visible');
    assert.equal((await admin('/api/admin/review')).body.photos.length,0);
    assert.equal((await admin('/api/admin/review',{kind:'photo',id:photo,action:'approve'})).status,409);
    assert.notEqual(delivered[0].event,delivered[1].event);
    assert.equal((await a('/api/photos/'+photo)).headers['content-type'],'image/jpeg');
    assert.equal((await c(path)).status,404);
    assert.equal((await c('/api/photos/'+photo)).status,404);
    assert.equal((await a('/api/admin/photos/'+photo)).status,401);
    const everyone=(await a('/api/people')).body;
    assert.deepEqual(everyone.map(p=>p.nick).sort(),['겨울','봄']);
    assert.deepEqual((await a('/api/people?area='+encodeURIComponent(profile.area))).body.map(p=>p.id),[profile.id]);
    assert.deepEqual((await a('/api/rooms')).body.map(r=>r.id),[room]);
    assert.deepEqual((await a('/api/rooms?area='+encodeURIComponent(profile.area))).body.map(r=>r.id),[room]);
    assert.deepEqual((await a('/api/rooms?area='+encodeURIComponent('인천광역시 검단구'))).body,[]);
    const nationwide=(await admin('/api/admin/rooms')).body;
    assert.equal(nationwide.length,1);assert.equal(nationwide[0].id,room);
    const {first,firstArea,second,secondArea}=nationwide[0];
    assert.deepEqual(new Map([[first,firstArea],[second,secondArea]]),new Map([['가을','경기도 이천시'],['겨울','서울특별시 중구']]));
    for(const area of ['서울특별시 중구','경기도 이천시'])
      assert.deepEqual((await admin('/api/admin/rooms?area='+encodeURIComponent(area))).body,nationwide);
    assert.equal((await a('/api/admin/rooms')).status,401);
    assert.equal((await nobody('/api/admin/rooms')).status,401);
    for(const [client,path] of [[a,'people'],[b,'rooms'],[admin,'admin/rooms']]){
      assert.equal((await client('/api/'+path+'?area=x')).status,400);
    }
    assert.deepEqual((await admin('/api/admin/rooms?area='+encodeURIComponent('인천광역시 검단구'))).body,[]);
    assert.equal((await admin('/api/admin/rooms/'+room+'/messages')).body.length,2);
    assert.equal((await admin('/api/admin/photos/'+photo)).status,200);
  });
  await t.test('안 읽은 개수는 수신 메시지만 세고 검증된 방별 읽음 위치를 기기 간에 유지한다',async()=>{
    const path='/api/rooms/'+room+'/messages';
    const first=(await b(path)).body[0].id;
    assert.equal((await nobody('/api/unread')).status,401);
    assert.deepEqual((await a('/api/unread')).body,{total:1,rooms:[{id:room,unread:1}]});
    assert.equal((await b('/api/rooms')).body[0].unread,1);
    assert.equal((await c('/api/rooms/'+room+'/read',{through:first})).status,404);
    for(const through of [-1,1.5,'1',Number.MAX_SAFE_INTEGER])
      assert.equal((await b('/api/rooms/'+room+'/read',{through})).status,400);
    assert.deepEqual((await b('/api/rooms/'+room+'/read',{through:first})).body,{unread:0});
    assert.equal((await b('/api/unread')).body.total,0);
    assert.deepEqual((await b('/api/rooms/'+room+'/read',{through:0})).body,{unread:0});
    const otherDevice=client();await pass(otherDevice,'','DI-B');
    assert.equal((await otherDevice('/api/unread')).body.total,0);
    assert.equal((await a('/api/unread')).body.total,1);
  });
  await t.test('관리자는 직접 입력한 회원 정보를 보고 신규 회원의 연락처는 수집하지 않는다',async()=>{
    const id=(await b('/api/state')).body.profile.id;
    const listing=await admin('/api/admin/members');assert.equal(listing.body.items.length,3);
    const path='/api/admin/members/'+id;
    assert.equal((await a(path)).status,401);assert.equal((await nobody(path)).status,401);
    const detail=(await admin(path)).body;
    assert.equal(detail.contact,null);assert.equal(detail.year,1995);assert.equal(detail.gender,'여성');assert.equal(detail.id,id);
    assert.equal(detail.identity,undefined);assert.equal(detail.encrypted,undefined);
    for(const res of [listing,await a('/api/state'),await a('/api/rooms'),await a('/api/people?area='+encodeURIComponent('서울특별시 중구')),await a('/api/rooms/'+room+'/messages')])
      assert.doesNotMatch(JSON.stringify(res.body),/검증회원|01000000000|phoneNumber|encrypted/);
    const saved=db.prepare('SELECT encrypted FROM contacts WHERE member=?').get(id);
    assert.equal(saved,undefined);
  });
  await t.test('신고한 콘텐츠는 즉시 숨기고 발신자·신고자를 회원 ID로 구분한다',async()=>{
    const idB=(await b('/api/state')).body.profile.id,idA=(await a('/api/state')).body.profile.id;
    const path='/api/rooms/'+room+'/messages';
    const report={kind:'message',reason:'불법촬영·비동의 유포 의심',message:photo};
    assert.equal((await b('/api/report',report)).status,404);
    assert.equal((await c('/api/report',report)).status,404);
    assert.equal((await a('/api/report',report)).status,200);
    assert.equal((await a('/api/report',report)).status,200);
    assert.equal((await b('/api/photos/'+photo)).status,403);
    const hidden=(await a(path)).body.at(-1);assert.equal(hidden.visibility,'reported');assert.equal(hidden.viewable,0);
    assert.equal((await a('/api/unread')).body.total,0);
    assert.equal((await a('/api/rooms/'+room+'/read',{through:photo})).status,400);
    const list=(await admin('/api/admin/review')).body.reports;assert.equal(list.length,1);
    assert.equal(list[0].sender,idB);assert.equal(list[0].reporter,idA);
    assert.equal((await a('/api/admin/review',{kind:'report',id:list[0].id,action:'dismiss'})).status,401);
    assert.equal((await admin('/api/admin/review',{kind:'report',id:list[0].id,action:'dismiss'})).status,200);
    assert.equal((await a('/api/photos/'+photo)).status,200);
    assert.equal((await admin('/api/admin/review',{kind:'report',id:list[0].id,action:'dismiss'})).status,200);
    assert.equal((await a('/api/unread')).body.total,1);
    assert.equal((await a('/api/rooms/'+room+'/read',{through:photo})).body.unread,0);
    assert.equal((await a(path,{body:'누드 사 진 보 내'})).status,422);
    assert.equal((await a(path,{body:'성향과 취미를 존중해요'})).status,200);
    const jpeg=Buffer.from([255,216,1,2,255,217]).toString('base64');
    assert.equal((await a(path,{photo:jpeg})).status,200);
    const incoming=(await b(path)).body.at(-1);
    assert.equal((await b('/api/photos/'+incoming.id)).status,200);
    await b('/api/report',{kind:'message',reason:'원치 않는 성적 대화·사진',message:incoming.id});
    const accepted=(await admin('/api/admin/review')).body.reports[0];
    assert.equal((await admin('/api/admin/review',{kind:'report',id:accepted.id,action:'accept'})).status,200);
    assert.equal((await admin('/api/admin/review',{kind:'report',id:accepted.id,action:'accept'})).status,200);
    assert.equal((await admin('/api/admin/review',{kind:'report',id:accepted.id,action:'dismiss'})).status,409);
    assert.equal((await b('/api/photos/'+incoming.id)).status,403);
    assert.equal(db.prepare('SELECT photo FROM messages WHERE id=?').get(incoming.id).photo,null);
    const detail=(await admin('/api/admin/members/'+idA)).body;
    assert.equal(detail.strikes,1);assert.equal(detail.totalStrikes,1);assert.equal(detail.restrictedUntil,0);
    assert.equal((await a('/api/state')).body.stage,'member');
  });
  await t.test('차단한 두 회원은 기존 방 조회·생성·사진 접근·전송이 양방향 차단된다',async()=>{
    const A=(await a('/api/state')).body.profile,B=(await b('/api/state')).body.profile;
    assert.equal((await a('/api/blocks',{peer:B.id})).status,200);
    for(const [user,peer] of [[a,B],[b,A]]){
      assert.equal((await user('/api/room',{peer:peer.id})).status,404);
      assert.equal((await user('/api/rooms/'+room+'/messages')).status,404);
      assert.equal((await user('/api/rooms/'+room+'/messages',{body:'hi'})).status,404);
      assert.equal((await user('/api/photos/'+photo)).status,404);
      assert.equal((await user('/api/rooms')).body.length,0);
      assert.deepEqual((await user('/api/unread')).body,{total:0,rooms:[]});
      assert.equal((await user('/api/rooms/'+room+'/read',{through:photo})).status,404);
      assert.equal((await user('/api/people?area='+encodeURIComponent(peer.area))).body.length,0);
      assert.ok(!(await user('/api/people')).body.some(p=>p.id===peer.id));
    }
    assert.equal((await a('/api/blocks')).body[0].id,B.id);
    await b('/api/blocks',{peer:A.id,remove:true});assert.equal((await b('/api/photos/'+photo)).status,404);
    await a('/api/blocks',{peer:B.id,remove:true});assert.equal((await b('/api/photos/'+photo)).status,404);
    assert.equal((await a('/api/room',{peer:B.id})).body.id,room);
    assert.equal((await b('/api/photos/'+photo)).status,403);
  });
  await t.test('푸시 재시도, 차단, 기기 교체, 만료 토큰과 로그아웃이 대기열에 반영된다',async()=>{
    const path='/api/rooms/'+room+'/messages';
    const idB=(await b('/api/state')).body.profile.id;
    await deliveryQueue.flush();delivered.length=0;
    await a(path,{body:'재시도'});
    pushResult='transient';await deliveryQueue.flush();
    assert.equal(db.prepare('SELECT tries FROM push_jobs').get().tries,1);
    now+=6000;pushResult='sent';
    await deliveryQueue.flush();await deliveryQueue.flush();
    assert.deepEqual(delivered.map(d=>d.token),[iphone.token]);
    await a(path,{body:'차단 전 보낸 메시지'});
    await a('/api/blocks',{peer:idB});await deliveryQueue.flush();
    assert.equal(delivered.length,1);
    await a('/api/blocks',{peer:idB,remove:true});
    await a('/api/room',{peer:idB});
    await a(path,{body:'기기 연결 변경 전 메시지'});
    await c('/api/push/device',iphone);await deliveryQueue.flush();assert.equal(delivered.length,1);
    await b('/api/push/device',iphone);
    const updated={...iphone,token:'ffff'.repeat(16)};
    await b('/api/push/device',updated);
    assert.equal(db.prepare('SELECT 1 FROM push_devices WHERE token=?').get(iphone.token),undefined);
    await a(path,{body:'토큰 정리'});pushResult='invalid';await deliveryQueue.flush();pushResult='sent';
    assert.equal(db.prepare('SELECT 1 FROM push_devices WHERE token=?').get(updated.token),undefined);
    await b('/api/push/device',iphone);await a(path,{body:'로그아웃 전 메시지'});
    await b('/api/logout',{});await deliveryQueue.flush();assert.equal(delivered.length,1);
    assert.equal(db.prepare('SELECT 1 FROM push_devices WHERE token=?').get(iphone.token),undefined);
    await pass(b,'','DI-B');await b('/api/push/device',iphone);
    await a(path,{photo:Buffer.from([255,216,255,217]).toString('base64')});
    photo=(await b(path)).body.at(-1).id;
  });
  await t.test('재시작 후에도 세션·폼·대화가 유지되고 12시간에 사진 열람 및 정리가 적용된다',async()=>{
    const version=(await a('/api/status')).body.version;
    const oldId=randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(id,kind,expires) VALUES(?,?,?)').run(oldId,'admin',now+hour);
    server.emit('close');server=makeServer(cfg,providers);
    assert.equal(db.prepare('SELECT id FROM sessions WHERE id=?').get(oldId),undefined);
    assert.equal((await admin('/api/admin/settings')).status,200);
    assert.equal((await a('/api/status')).body.version,version);
    assert.equal((await a('/api/state')).body.stage,'member');
    assert.equal((await a('/api/unread')).body.total,0);
    assert.equal((await nobody('/apply')).headers.location,'https://two.example/apply');
    const stamp=db.prepare('SELECT expires FROM messages WHERE id=?').get(photo).expires;
    now=stamp-1;assert.equal((await b('/api/photos/'+photo)).status,200);
    now=stamp;assert.equal((await b('/api/photos/'+photo)).status,410);
    clean(db,now);assert.equal(db.prepare('SELECT photo FROM messages WHERE id=?').get(photo).photo,null);
    assert.equal((await a('/api/rooms/'+room+'/messages')).body[0].visibility,'deleted');
    await admin('/api/admin/login',{key:adminKey});
    assert.equal((await admin('/api/admin/rooms/'+room+'/messages')).body[0].body,'반가워요');
  });
  await t.test('이전 버전 회원 세션과 대화는 유지되고 검토 이력이 없는 사진은 즉시 표시한다',async()=>{
    const C=(await c('/api/state')).body.profile, A=(await a('/api/state')).body.profile;
    db.prepare('DELETE FROM account_keys WHERE member=?').run(C.id);
    db.prepare('DELETE FROM acceptances WHERE member=?').run(C.id);
    server.emit('close');server=makeServer(cfg,providers);
    assert.equal((await c('/api/state')).body.stage,'policy');
    assert.equal((await c('/api/state')).body.needsRecoveryCopy,true);
    assert.equal((await c('/api/account/recovery')).body.code,recovery.get('DI-C'));
    assert.equal((await c('/api/people?area='+encodeURIComponent(C.area))).status,403);
    assert.equal((await c('/api/policy',{version:policyVersion})).status,200);
    assert.deepEqual((await c('/api/state')).body.profile,C);
    const old=db.prepare('INSERT INTO messages(room,author,sent,photo,expires) VALUES(?,?,?,?,?)').run(room,A.id,now,Buffer.from([255,216,255,217]),now+12*hour);
    server.emit('close');server=makeServer(cfg,providers);
    assert.equal((await b('/api/photos/'+old.lastInsertRowid)).status,200);
    assert.equal(db.prepare('SELECT state FROM reviews WHERE message=?').get(old.lastInsertRowid).state,'approved');
  });
  await t.test('탈퇴하면 전 기기 세션이 종료되고 24시간 뒤 새 계정으로 가입한다',async()=>{
    const other=client();assert.equal((await pass(other,'','DI-A')).body.stage,'member');
    await admin('/api/admin/login',{key:adminKey});
    const old=(await a('/api/state')).body.profile.id;
    assert.equal((await a('/api/withdraw',{confirm:true})).status,200);
    assert.equal((await other('/api/state')).body.stage,'gate');
    assert.equal((await b('/api/rooms')).body.length,0);
    const directory=await admin('/api/admin/members');
    assert.deepEqual(directory.body.counts,{active:2,inactive:0,withdrawn:1});
    const record=(await admin('/api/admin/members/'+old)).body;
    assert.deepEqual(Object.keys(record).sort(),['expires','nick','status','withdrawn']);
    assert.equal(record.status,'withdrawn');assert.equal(record.expires-record.withdrawn,24*hour);
    assert.equal(db.prepare('SELECT encrypted FROM contacts WHERE member=?').get(old),undefined);
    now+=24*hour-1;await admin('/api/admin/login',{key:adminKey});
    assert.equal((await admin('/api/admin/members/'+old)).status,200);
    assert.equal((await pass(a,'새 이름','DI-A')).status,403);
    const reinstall=client();
    assert.equal((await reinstall('/api/account/login',{code:recovery.get('DI-A')})).status,403);
    assert.equal((await pass(other,'다른 닉네임','new-alias')).status,403);
    now+=1;
    assert.equal((await admin('/api/admin/members/'+old)).status,404);
    assert.deepEqual((await admin('/api/admin/members')).body.counts,{active:2,inactive:0,withdrawn:0});
    assert.equal((await pass(a,'새 이름','DI-A')).body.stage,'details');
    assert.equal((await a('/api/register',{area:'경기도 이천시',policy:policyVersion,memo:'새 메모'})).status,200);
    assert.notEqual((await a('/api/state')).body.profile.id,old);
    clean(db,now);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cooldowns').get().n,0);
  });
  await t.test('신고 승인 3회마다 24시간 제한하며 중복 결정은 가산하지 않고 만료·재제재·탈퇴를 처리한다',async()=>{
    const C=(await c('/api/state')).body.profile;
    const B=(await b('/api/state')).body.profile;
    await admin('/api/admin/login',{key:adminKey});
    const dialog=(await c('/api/room',{peer:B.id})).body.id;
    const path='/api/rooms/'+dialog+'/messages';
    for(let cycle=0;cycle<2;cycle++){
      for(let strike=1;strike<=3;strike++){
        assert.equal((await c(path,{body:'신고 대상 '+cycle+' '+strike})).status,200);
        const message=(await b(path)).body.at(-1).id;
        await b('/api/report',{kind:'message',message,reason:'괴롭힘·기타 위반'});
        const r=(await admin('/api/admin/review')).body.reports[0];
        assert.equal((await admin('/api/admin/review',{kind:'report',id:r.id,action:'accept'})).status,200);
        assert.equal((await admin('/api/admin/review',{kind:'report',id:r.id,action:'accept'})).status,200);
        const detail=(await admin('/api/admin/members/'+C.id)).body;
        assert.equal(detail.totalStrikes,cycle*3+strike);assert.equal(detail.strikes,strike%3);
        assert.equal((await c('/api/status')).body.stage,strike===3?'restricted':'member');
        if(strike===3)assert.equal(detail.restrictedUntil,now+24*hour);
      }
      assert.equal((await c('/api/people')).status,403);
      await pass(c,'','DI-C');assert.equal((await c('/api/state')).body.stage,'restricted');
      if(cycle===0){
        now+=24*hour-1;assert.equal((await c('/api/status')).body.stage,'restricted');
        now+=1;assert.equal((await c('/api/status')).body.stage,'member');
        await admin('/api/admin/login',{key:adminKey});
      }
    }
    assert.equal((await c('/api/withdraw',{confirm:true})).status,200);
    now+=23*hour;assert.equal((await pass(c,'다시','DI-C')).status,403);
    now+=hour;assert.equal((await pass(c,'다시','DI-C')).body.stage,'details');
    await c('/api/register',{area:C.area,memo:'취미',policy:policyVersion});
  });
  await t.test('초기화 시 진행 중 인증·세션·설정·서비스 데이터까지 제거한다',async()=>{
    await admin('/api/admin/login',{key:adminKey});
    assert.equal((await admin('/api/admin/reset',{key:adminKey,confirm:'취소'})).status,403);
    assert.equal((await admin('/api/admin/reset',{key:adminKey,confirm:'전체 삭제'},{origin:'https://other.example'})).status,403);
    const oldVersion=(await c('/api/status')).body.version;
    const oldMember=(await c('/api/state')).body.profile.id;
    assert.equal((await c('/api/push/device',android)).status,200);
    // Include a fresh tombstone when resetting, before its 24-hour expiry.
    const departing=(await b('/api/state')).body.profile;
    if(!departing)await pass(b,'','DI-B');
    await b('/api/withdraw',{confirm:true});
    assert.equal((await admin('/api/admin/members')).body.counts.withdrawn,1);
    const probe='reset-probe-'+randomBytes(10).toString('hex');
    db.prepare('INSERT INTO settings VALUES(?,?)').run('reset-check',probe);
    assert.ok(readFileSync(join(dir,'chat.sqlite')).includes(Buffer.from(probe)));
    let releaseAdmin,signal;
    const lateKey='kyh-codenote-'+randomBytes(12).toString('hex'),lateAdmin=client();
    const checking=new Promise(r=>signal=r);
    registry.set(lateKey,()=>{signal();return new Promise(r=>releaseAdmin=r);});
    const loginPending=lateAdmin('/api/admin/login',{key:lateKey},{ip:'late-login'});await checking;
    const began=new Promise(r=>started=r);const pending=nobody('/api/key',{code:'slow'});await began;
    assert.equal((await admin('/api/admin/reset',{key:adminKey,confirm:'전체 삭제'})).status,200);
    releaseAdmin({status:'approved',token:'delayed'});
    assert.equal((await loginPending).status,409);
    assert.equal((await lateAdmin('/api/admin/settings')).status,401);
    unblock();assert.equal((await pending).status,409);
    assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete,1);
    assert.equal(readFileSync(join(dir,'chat.sqlite')).includes(Buffer.from(probe)),false);
    for(const table of tables)assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
    assert.equal((await a('/api/state')).body.stage,'gate');
    assert.equal((await admin('/api/admin/settings')).status,401);
    const after=(await c('/api/status')).body;
    assert.notEqual(after.version,oldVersion);assert.equal(after.stage,'gate');
    assert.equal((await admin('/api/admin/login',{key:adminKey})).status,200);
    assert.equal((await admin('/api/admin/members/'+oldMember)).status,404);
    assert.deepEqual((await admin('/api/admin/members')).body,{items:[],more:false,counts:{active:0,inactive:0,withdrawn:0}});
    assert.deepEqual((await admin('/api/admin/review')).body,{photos:[],reports:[]});
    assert.match(String((await nobody('/apply')).body),/발급 주소/);
    assert.match((await nobody('/apply',undefined,{userAgent:'WebView PaperChatAndroid/2'})).headers.location,/unavailable/);
  });
});

test('기존 pending 사진 이관은 신고·삭제·만료를 보존하고 동일 콘텐츠 신고 벌점은 한 번만 부여한다',t=>{
  const dir=mkdtempSync(join(tmpdir(),'paperchat-migrate-'));let db=openStore(dir);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const now=Date.now();
  for(const id of ['author','receiver','other'])
    db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)').run(id,id+'-identity',id,1995,'여성','경기도 이천시','소개');
  db.prepare('INSERT INTO rooms(id,a,b) VALUES(?,?,?)').run('room','author','receiver');
  const ids=[];
  for(const [state,expires] of [['pending',now+hour],['pending',now+hour],['removed',now+hour],['pending',now-1]]){
    const id=Number(db.prepare('INSERT INTO messages(room,author,sent,photo,expires) VALUES(?,?,?,?,?)').run('room','author',now,Buffer.from([255,216,255,217]),expires).lastInsertRowid);
    db.prepare('INSERT INTO reviews VALUES(?,?)').run(id,state);ids.push(id);
  }
  const reason='괴롭힘·기타 위반';
  db.prepare('INSERT INTO reports(reporter,target,message,reason,created) VALUES(?,?,?,?,?)').run('receiver','author',ids[1],reason,now);
  db.close();db=openStore(dir);
  assert.deepEqual(ids.map(id=>db.prepare('SELECT state FROM reviews WHERE message=?').get(id).state),['approved','pending','removed','pending']);
  const safety=moderation(db),legacy=db.prepare('SELECT id,content FROM reports').get();
  assert.equal(legacy.content,'message:'+ids[1]);
  safety.reportDecision(legacy.id,'dismiss');
  assert.equal(db.prepare('SELECT state FROM reviews WHERE message=?').get(ids[1]).state,'approved');
  safety.report('receiver',{kind:'profile',peer:'author',reason});
  safety.report('other',{kind:'profile',peer:'author',reason});
  const reports=safety.queue().reports;assert.equal(reports.length,2);
  safety.reportDecision(reports[0].id,'accept');
  safety.reportDecision(reports[1].id,'accept');
  assert.equal(safety.penalty('author-identity').totalStrikes,1);
  assert.equal(safety.penalty('author-identity').restrictedUntil,0);
  assert.equal(safety.queue().reports.length,0);
  db.prepare("UPDATE members SET memo='새 소개' WHERE id='author'").run();
  safety.report('receiver',{kind:'profile',peer:'author',reason});
  const next=safety.queue().reports;assert.equal(next.length,1);
  safety.reportDecision(next[0].id,'accept');
  assert.equal(safety.penalty('author-identity').totalStrikes,2);
  db.prepare('INSERT INTO room_reads VALUES(?,?,?)').run('room','receiver',ids[0]);
  db.prepare("DELETE FROM members WHERE id='receiver'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM room_reads').get().n,0);
});
