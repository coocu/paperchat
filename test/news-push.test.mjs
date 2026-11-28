import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH,generateKeyPairSync,randomBytes,randomUUID } from 'node:crypto';
import { makeServer } from '../server.mjs';
import { openStore,clean,hour } from '../store.mjs';
import { moderation } from '../moderation.mjs';
import { pushQueue } from '../push-queue.mjs';
import { pushProvider } from '../push-provider.mjs';
import { webPushProvider } from '../web-push.mjs';
import { policyVersion } from '../public/rules.js';

const photo=Buffer.from([255,216,11,12,13,255,217]).toString('base64');
const reason='괴롭힘·기타 위반';
const subscription=()=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID(),
  keys:{p256dh:createECDH('prime256v1').generateKeys().toString('base64url'),auth:randomBytes(16).toString('base64url')}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-news-push-')),origin='https://paperchat.example';
  let now=Date.UTC(2026,10,28,0,0,0),failure=null,beforeSend=null;
  t.mock.method(Date,'now',()=>now);t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const db=openStore(dir),secret=randomBytes(40).toString('hex'),safety=moderation(db),delivered=[],attempts=[];
  const web=webPushProvider(db,secret,async(sub,payload)=>{
    attempts.push({platform:'web',sub,payload:JSON.parse(payload)});
    if(failure)throw failure;delivered.push({platform:'web',sub,payload:JSON.parse(payload)});
  });
  const native={enabled:()=>true,async send(job,event,valid){
    if(!valid())return 'skip';attempts.push({platform:job.platform,job:{...job},event});
    if(failure)throw failure;delivered.push({platform:job.platform,job:{...job},event});return 'sent';
  }};
  const provider={enabled:()=>true,async send(job,event,valid){
    if(beforeSend)await beforeSend(job);
    return (job.platform==='web'?web:native).send(job,event,valid);
  }};
  const config={dir,origin,secret,pushProvider:native,webPushProvider:web};
  const upstream={async check(){return {status:'approved',token:'fixture-token'};}};
  let server=makeServer(config,upstream),queue=pushQueue(db,provider,safety);
  t.after(()=>{queue.close();server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    return async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin??origin,'user-agent':'test-browser',
        cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),...options.headers};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(key){return headers[key.toLowerCase()];},setHeader(key,value){headers[key.toLowerCase()]=value;},
          writeHead(status,h){this.status=status;for(const [key,value]of Object.entries(h||{}))this.setHeader(key,value);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(error){reject(error);}
      });
    };
  }
  async function member(nick) {
    const call=client();
    assert.equal((await call('/api/key',{code:'reusable-news-push-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area:'서울 동부',memo:'비공개 프로필 소개',policy:policyVersion})).status,200);
    const id=(await call('/api/state')).body.profile.id,code=(await call('/api/account/recovery')).body.code;
    const session=db.prepare("SELECT id FROM sessions WHERE member=? AND kind='member'").get(id).id;
    return {call,id,code,session,nick};
  }
  async function bind(member,platform='web',sub=subscription()) {
    const token=platform==='android'?'news-fcm-device-'+randomUUID():randomBytes(32).toString('hex');
    const response=await member.call(platform==='web'?'/api/push/web':'/api/push/device',platform==='web'?{subscription:sub}:{platform,token});
    assert.equal(response.status,200);assert.equal(response.body.configured,true);
    return {...db.prepare('SELECT * FROM push_devices WHERE session=? AND platform=?').get(member.session,platform),sub};
  }
  const identity=member=>db.prepare('SELECT identity FROM members WHERE id=?').get(member.id).identity;
  return {db,safety,client,member,bind,identity,delivered,attempts,web,
    now:()=>now,advance(ms){now+=ms;},flush:()=>queue.flush(),fail(error){failure=error;},before(fn){beforeSend=fn;},
    restart(){queue.close();server.emit('close');server=makeServer(config,upstream);queue=pushQueue(db,provider,safety);}};
}

async function upload(member) {
  const response=await member.call('/api/news',{photo});assert.equal(response.status,200);return response.body.item;
}
async function like(member,post,liked=true) {
  const response=await member.call('/api/news/'+post.id+'/like',{liked});assert.equal(response.status,200);return response.body;
}
async function comment(member,post,body='알림에 포함하면 안 되는 댓글 원문') {
  const response=await member.call('/api/news/'+post.id+'/comments',{body});assert.equal(response.status,200);return response.body.item;
}
const events=f=>f.db.prepare('SELECT * FROM news_push_events ORDER BY rowid').all();
const lastEvent=f=>events(f).at(-1);
async function check(call,device,post,event,extra='') {
  const response=await call('/api/push/web/check?kind=news&postId='+post.id+'&event='+event.id+'&device='+device.id+extra);
  assert.equal(response.status,200);return response.body;
}
const report=(member,kind,id)=>member.call('/api/news/report',{kind,id,reason});

test('소식 좋아요·댓글 알림은 자기 반응을 제외하고 게시자의 등록 기기에만 전달한다',async t=>{
  const f=fixture(t),owner=await f.member('사진 게시자'),actor=await f.member('익명 반응자의 비공개 이름'),other=await f.member('무관한 회원');
  const ownDevices=await Promise.all(['web','android','ios-prod'].map(platform=>f.bind(owner,platform)));
  const actorDevice=await f.bind(actor),otherDevice=await f.bind(other),post=await upload(owner);
  await f.flush();assert.equal(f.delivered.length,0);
  await like(owner,post);await comment(owner,post,'내 사진에 쓴 내 댓글');await f.flush();assert.equal(f.delivered.length,0);assert.equal(events(f).length,0);
  await like(actor,post);await f.flush();assert.equal(f.delivered.length,3);
  await comment(actor,post);await f.flush();assert.equal(f.delivered.length,6);
  for(const entry of f.delivered){
    const device=entry.platform==='web'?ownDevices.find(device=>device.platform==='web'):ownDevices.find(device=>device.id===entry.job.device);
    assert.ok(device,'게시자 기기 외에는 전달하면 안 됩니다.');
    if(entry.platform==='web'){
      assert.equal(entry.sub.endpoint,device.sub.endpoint);
      assert.notEqual(entry.sub.endpoint,actorDevice.sub.endpoint);assert.notEqual(entry.sub.endpoint,otherDevice.sub.endpoint);
      const serialized=JSON.stringify(entry.payload);
      for(const secret of [owner.id,actor.id,actor.nick,'알림에 포함하면 안 되는 댓글 원문',photo])assert.equal(serialized.includes(secret),false);
    }
  }
});

test('좋아요 재시도·해제 후 재좋아요·재시작은 알림을 재발행하지 않고 전송 실패만 같은 이벤트로 재시도한다',async t=>{
  const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),device=await f.bind(owner),post=await upload(owner);
  await Promise.all([like(actor,post),like(actor,post)]);assert.equal(events(f).length,1);const event=lastEvent(f);
  assert.deepEqual(await check(owner.call,device,post,event),{notify:true,postId:post.id,newsType:'like'});
  const warnings=t.mock.method(console,'warn',()=>{});f.fail(Object.assign(Error('private gateway credentials'),{statusCode:503}));
  await f.flush();assert.equal(f.delivered.length,0);assert.equal(events(f).length,1);
  f.fail(null);f.advance(5000);await f.flush();warnings.mock.restore();
  assert.equal(f.delivered.length,1);assert.equal(f.delivered[0].payload.event,event.id);
  await like(actor,post);await like(actor,post,false);assert.deepEqual(await check(owner.call,device,post,event),{notify:false});
  await like(actor,post);f.restart();await f.flush();assert.equal(f.delivered.length,1);assert.equal(events(f).length,1);
  assert.deepEqual(await check(owner.call,device,post,event),{notify:false});
  const next=await upload(owner);await like(actor,next);const cancelled=lastEvent(f);await like(actor,next,false);
  await f.flush();assert.equal(f.delivered.length,1);
  await like(actor,next);await f.flush();assert.equal(f.delivered.length,1);
  assert.deepEqual(await check(owner.call,device,next,cancelled),{notify:false});
});

test('댓글은 댓글 ID별로 알리고 신고된 댓글만 제외하며 게시자에게 원문이나 익명 작성자를 노출하지 않는다',async t=>{
  const f=fixture(t),owner=await f.member('사진 게시자'),actor=await f.member('숨겨야 할 작성자 이름'),reporter=await f.member('신고자'),device=await f.bind(owner),post=await upload(owner);
  const first=await comment(actor,post,'첫 비공개 댓글 원문'),firstEvent=lastEvent(f);
  const second=await comment(actor,post,'두 번째 비공개 댓글 원문'),secondEvent=lastEvent(f);
  assert.notEqual(first.id,second.id);assert.notEqual(firstEvent.id,secondEvent.id);
  assert.equal((await report(reporter,'comment',first.id)).status,200);
  assert.deepEqual(await check(owner.call,device,post,firstEvent),{notify:false});
  assert.deepEqual(await check(owner.call,device,post,secondEvent),{notify:true,postId:post.id,newsType:'comment'});
  await f.flush();assert.equal(f.delivered.length,1);
  assert.deepEqual(f.delivered[0].payload,{kind:'news',event:secondEvent.id,postId:post.id,newsType:'comment',device:device.id});
  assert.doesNotMatch(JSON.stringify(f.delivered[0].payload),/원문|작성자|nick|author|commentId|body|photo/);
});

test('교체·삭제·신고·차단·탈퇴와 계정 상태 변경은 대기 중인 소식 알림과 웹의 늦은 표시를 막는다',async t=>{
  const cases=[
    ['좋아요 취소','like',async(f,owner,actor,post)=>like(actor,post,false)],
    ['사진 교체','comment',async(f,owner)=>upload(owner)],
    ['사진 삭제','like',async(f,owner,actor,post)=>owner.call('/api/news/'+post.id+'/delete',{confirm:true})],
    ['사진 신고','like',async(f,owner,actor,post)=>report(actor,'post',post.id)],
    ['댓글 삭제','comment',async(f,owner,actor,post,entry)=>actor.call('/api/news/comments/'+entry.id+'/delete',{confirm:true})],
    ['댓글 신고','comment',async(f,owner,actor,post,entry)=>report(owner,'comment',entry.id)],
    ['게시자가 차단','like',async(f,owner,actor)=>owner.call('/api/blocks',{peer:actor.id})],
    ['반응자가 차단','comment',async(f,owner,actor)=>actor.call('/api/blocks',{peer:owner.id})],
    ['게시자 제재','like',async(f,owner)=>f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(f.identity(owner),f.now()+hour)],
    ['반응자 제재','comment',async(f,owner,actor)=>f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(f.identity(actor),f.now()+hour)],
    ['게시자 약관 재동의','comment',async(f,owner)=>f.db.prepare('DELETE FROM acceptances WHERE member=?').run(owner.id)],
    ['반응자 약관 재동의','like',async(f,owner,actor)=>f.db.prepare('DELETE FROM acceptances WHERE member=?').run(actor.id)],
    ['게시자 로그아웃','like',async(f,owner)=>owner.call('/api/logout',{})],
    ['게시자 세션 만료','comment',async(f,owner)=>f.db.prepare('UPDATE sessions SET expires=? WHERE id=?').run(f.now(),owner.session)],
    ['반응자 탈퇴','like',async(f,owner,actor)=>actor.call('/api/withdraw',{confirm:true})],
    ['게시자 탈퇴','comment',async(f,owner)=>owner.call('/api/withdraw',{confirm:true})]
  ];
  for(const [name,kind,change]of cases)await t.test(name,async t=>{
    const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),device=await f.bind(owner),post=await upload(owner);
    const entry=kind==='like'?await like(actor,post):await comment(actor,post),event=lastEvent(f);
    assert.equal((await check(owner.call,device,post,event)).notify,true);
    await change(f,owner,actor,post,entry);
    assert.deepEqual(await check(owner.call,device,post,event),{notify:false});
    await f.flush();assert.equal(f.delivered.length,0,name);
  });
});

test('알림을 보내기 직전 다시 확인하여 대기 도중 댓글 신고나 게시자 로그아웃이 생기면 전송하지 않는다',async t=>{
  for(const platform of ['web','android'])await t.test(platform,async t=>{
    const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자');await f.bind(owner,platform);
    const post=await upload(owner),entry=await comment(actor,post),started=deferred(),release=deferred();
    f.before(async()=>{started.resolve();await release.promise;});const sending=f.flush();await started.promise;
    if(platform==='web')await report(owner,'comment',entry.id);else await owner.call('/api/logout',{});
    release.resolve();await sending;assert.equal(f.attempts.length,0);assert.equal(f.delivered.length,0);
  });
});

test('웹 수신 검증은 event·post·device·현재 계정을 묶고 계정 전환이나 endpoint 재등록 뒤 이전 알림을 거부한다',async t=>{
  const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),other=await f.member('다른 계정'),device=await f.bind(owner),post=await upload(owner);
  await like(actor,post);const event=lastEvent(f);
  for(const call of [f.client(),actor.call,other.call])assert.deepEqual(await check(call,device,post,event),{notify:false});
  const otherDevice=await f.bind(other);
  assert.deepEqual(await check(other.call,otherDevice,post,event),{notify:false});
  for(const wrong of [{...post,id:post.id+1},{...post,id:'invalid'}])assert.deepEqual(await check(owner.call,device,wrong,event),{notify:false});
  assert.deepEqual(await check(owner.call,device,post,{id:randomUUID()}),{notify:false});
  assert.deepEqual(await check(owner.call,{id:randomUUID()},post,event),{notify:false});
  assert.deepEqual(await check(owner.call,device,post,event,'&newsType=comment'),{notify:true,postId:post.id,newsType:'like'});
  await f.flush();assert.equal(f.delivered.length,1);
  assert.deepEqual(await check(owner.call,device,post,event),{notify:true,postId:post.id,newsType:'like'});
  assert.equal((await owner.call('/api/account/login',{code:other.code})).status,200);
  assert.deepEqual(await check(owner.call,device,post,event),{notify:false});
  const moved=await f.bind(other,'web',device.sub);
  assert.deepEqual(await check(other.call,moved,post,event),{notify:false});
});

test('소식 공개 12시간과 이벤트 전달 기한이 지나면 재시도·이미 도착한 웹 알림도 차단한다',async t=>{
  const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),device=await f.bind(owner),post=await upload(owner);
  f.advance(12*hour-1000);await like(actor,post);const event=lastEvent(f);
  f.advance(999);assert.equal((await check(owner.call,device,post,event)).notify,true);
  f.advance(1);assert.deepEqual(await check(owner.call,device,post,event),{notify:false});
  await f.flush();assert.equal(f.delivered.length,0);clean(f.db,f.now());
  const next=await upload(owner);await comment(actor,next);const late=lastEvent(f);await f.flush();assert.equal(f.delivered.length,1);
  f.advance(10*60*1000);assert.deepEqual(await check(owner.call,device,next,late),{notify:false});
  await f.flush();assert.equal(f.delivered.length,1);
});

function nativeSettings() {
  const google=generateKeyPairSync('rsa',{modulusLength:2048}),apple=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  return {GOOGLE_APPLICATION_CREDENTIALS:'/not-mounted/news-test.json',APNS_KEY_PATH:'/not-mounted/news-test.p8',
    FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'news-test',client_email:'test@example.invalid',private_key:google.privateKey.export({type:'pkcs8',format:'pem'})}),
    APNS_TEAM_ID:'TESTTEAM',APNS_KEY_ID:'TESTKEY',APNS_PRIVATE_KEY:apple.privateKey.export({type:'pkcs8',format:'pem'})};
}

test('FCM·APNs 소식 payload는 고정 안내와 이동 식별자만 전송하며 익명 댓글 작성자·원문을 보내지 않는다',async()=>{
  const fcm=[],apple=[],provider=pushProvider(nativeSettings(),async(url,request)=>{
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture-access',expires_in:3600});
    assert.equal(url,'https://fcm.googleapis.com/v1/projects/news-test/messages:send');
    fcm.push(JSON.parse(request.body));return Response.json({name:'ok'});
  },async(host,headers,payload)=>{apple.push({host,headers,payload});return {status:200};});
  for(const newsType of ['like','comment']){
    const event=randomUUID(),job={kind:'news',postId:17,newsType,token:'fixture-device',actor:'PRIVATE_ACTOR',
      nick:'PRIVATE_NICK',body:'PRIVATE_COMMENT_BODY',photo:'PRIVATE_PHOTO',commentId:234};
    assert.equal(await provider.send({...job,platform:'android'},event,()=>true),'sent');
    assert.deepEqual(fcm.at(-1).message,{token:'fixture-device',android:{priority:'high',ttl:'120s'},data:{kind:'news',event,postId:'17',newsType}});
    for(const platform of ['ios-dev','ios-prod']){
      assert.equal(await provider.send({...job,platform},event,()=>true),'sent');
      const delivery=apple.at(-1);
      assert.equal(delivery.host,platform==='ios-dev'?'api.sandbox.push.apple.com':'api.push.apple.com');
      assert.deepEqual(delivery.payload,{aps:{alert:{title:'종이편지',body:newsType==='like'?'회원님의 소식에 좋아요가 달렸어요.':'회원님의 소식에 새 댓글이 달렸어요.'},sound:'default'},kind:'news',event,postId:'17',newsType});
      assert.equal(delivery.headers['apns-collapse-id'],event);
    }
    assert.equal(await provider.send({...job,platform:'android'},event,()=>false),'skip');
    assert.equal(await provider.send({...job,platform:'ios-prod'},event,()=>false),'skip');
  }
  assert.equal(fcm.length,2);assert.equal(apple.length,4);
  assert.doesNotMatch(JSON.stringify([...fcm,...apple.map(row=>row.payload)]),/PRIVATE_|actor|nick|commentId|photo/);
});

test('FCM OAuth 응답이 늦게 도착해도 그동안 취소된 소식 알림은 전송하지 않는다',async()=>{
  const started=deferred(),release=deferred();let allowed=true,sends=0;
  const provider=pushProvider(nativeSettings(),async(url)=>{
    if(url==='https://oauth2.googleapis.com/token'){started.resolve();await release.promise;return Response.json({access_token:'fixture-access',expires_in:3600});}
    sends++;return Response.json({name:'should-not-send'});
  });
  const sending=provider.send({platform:'android',token:'fixture-device',kind:'news',postId:17,newsType:'comment'},randomUUID(),()=>allowed);
  await started.promise;allowed=false;release.resolve();assert.equal(await sending,'skip');assert.equal(sends,0);
});

test('알림 저장 실패는 반응과 함께 원복되고 만료·전체 초기화는 연결된 이벤트·대상·큐까지 정리한다',async t=>{
  const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),device=await f.bind(owner),post=await upload(owner);
  f.db.exec("CREATE TRIGGER fail_news_push_job BEFORE INSERT ON news_push_jobs BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  const logging=t.mock.method(console,'error',()=>{});
  assert.equal((await actor.call('/api/news/'+post.id+'/like',{liked:true})).status,500);
  assert.equal((await actor.call('/api/news/'+post.id+'/comments',{body:'원복되어야 할 댓글'})).status,500);
  logging.mock.restore();f.db.exec('DROP TRIGGER fail_news_push_job');
  for(const table of ['news_likes','news_comments','news_push_events','news_push_targets','news_push_jobs'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  await like(actor,post);f.advance(12*hour);clean(f.db,f.now());
  for(const table of ['news_push_events','news_push_targets','news_push_jobs'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_posts').get().n,1,'관리자 원문24h 보관은 알림12h 정리와 분리합니다.');
  const next=await upload(owner);await comment(actor,next);const event=lastEvent(f),admin=f.client();
  assert.equal((await admin('/api/admin/login',{key:'codenote-news-push-kyh'})).status,200);
  assert.equal((await admin('/api/admin/reset',{key:'codenote-news-push-kyh',confirm:'전체 삭제'})).status,200);
  for(const table of ['news_push_events','news_push_targets','news_push_jobs','push_devices'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  assert.deepEqual(await check(owner.call,device,next,event),{notify:false});await f.flush();assert.equal(f.delivered.length,0);
});

test('만료된 브라우저 구독을 제거한 뒤 다른 기기 등록·같은 좋아요 요청으로 이전 이벤트를 재발송하지 않는다',async t=>{
  const f=fixture(t),owner=await f.member('게시자'),actor=await f.member('반응자'),device=await f.bind(owner),post=await upload(owner);
  await like(actor,post);const event=lastEvent(f);
  f.fail(Object.assign(Error('expired private subscription'),{statusCode:410}));await f.flush();
  assert.equal(f.db.prepare('SELECT 1 FROM push_devices WHERE id=?').get(device.id),undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_push_targets').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_push_jobs').get().n,0);
  const replacement=await f.bind(owner);f.fail(null);await like(actor,post);await f.flush();
  assert.equal(f.delivered.length,0);assert.equal(events(f).length,1);
  assert.deepEqual(await check(owner.call,replacement,post,event),{notify:false});
});
