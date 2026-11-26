import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,verify } from 'node:crypto';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushProvider } from '../push-provider.mjs';

function signed(assertion, pub, ec=false) {
  const [head,claims,signature]=assertion.split('.');
  assert.ok(verify('sha256',Buffer.from(head+'.'+claims),ec?{key:pub,dsaEncoding:'ieee-p1363'}:pub,Buffer.from(signature,'base64url')));
  return JSON.parse(Buffer.from(claims,'base64url'));
}

test('FCM HTTP v1 signs OAuth, caches it, sends a private high priority data message, handles unregistered tokens',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'push-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const path=join(dir,'service.json');
  writeFileSync(path,JSON.stringify({project_id:'testing',client_email:'test@example.invalid',
    private_key:keys.privateKey.export({type:'pkcs8',format:'pem'})}));
  let oauth=0,sends=0;
  const provider=pushProvider({GOOGLE_APPLICATION_CREDENTIALS:path},async(url,request)=>{
    if(url==='https://oauth2.googleapis.com/token'){
      oauth++;
      const claims=signed(request.body.get('assertion'),keys.publicKey);
      assert.equal(claims.scope,'https://www.googleapis.com/auth/firebase.messaging');
      return Response.json({access_token:'test-access',expires_in:3600});
    }
    assert.equal(url,'https://fcm.googleapis.com/v1/projects/testing/messages:send');
    assert.equal(request.headers.Authorization,'Bearer test-access');
    assert.deepEqual(JSON.parse(request.body).message,{token:'registration',android:{priority:'high',ttl:'120s'},data:{kind:'chat',event:'event-1'}});
    sends++;
    return sends===1?Response.json({name:'ok'}):Response.json({error:{details:[{errorCode:'UNREGISTERED'}]}},{status:404});
  });
  const dev={platform:'android',token:'registration'};
  assert.equal(await provider.send(dev,'event-1',()=>true),'sent');
  assert.equal(await provider.send(dev,'event-1',()=>false),'skip');
  assert.equal(await provider.send(dev,'event-1',()=>true),'invalid');
  assert.equal(oauth,1);assert.equal(sends,2);
});

test('APNs signs ES256, separates development and production and requests a visible audible alert',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'push-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const keys=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const path=join(dir,'apns.p8');writeFileSync(path,keys.privateKey.export({type:'pkcs8',format:'pem'}));
  const hosts=[];
  const provider=pushProvider({APNS_KEY_PATH:path,APNS_TEAM_ID:'team',APNS_KEY_ID:'key',
    GOOGLE_APPLICATION_CREDENTIALS:join(dir,'missing')},undefined,async(host,headers,payload)=>{
    hosts.push(host);
    assert.equal(signed(headers.authorization.slice(7),keys.publicKey,true).iss,'team');
    assert.equal(headers['apns-topic'],'com.codenote.paperchat');
    assert.equal(headers['apns-push-type'],'alert');assert.equal(headers['apns-priority'],'10');
    assert.deepEqual(payload,{aps:{alert:{title:'종이편지',body:'새 메시지가 도착했어요.'},sound:'default'},kind:'chat'});
    return hosts.length===1?{status:200}:{status:410,reason:'Unregistered'};
  });
  assert.equal(await provider.send({platform:'ios-dev',token:'abcd'},'id',()=>true),'sent');
  assert.equal(await provider.send({platform:'ios-prod',token:'abcd'},'id',()=>true),'invalid');
  assert.deepEqual(hosts,['api.sandbox.push.apple.com','api.push.apple.com']);
});

const sampleAppId='1:123456789:android:abc123';
const sampleApiKey='A'+'x'.repeat(38);
function androidJson() {
  return JSON.stringify({project_info:{project_id:'paperchat-qa',project_number:'123456789'},client:[
    {client_info:{android_client_info:{package_name:'other.app'}},api_key:[{current_key:'wrong'}]},
    {client_info:{mobilesdk_app_id:sampleAppId,android_client_info:{package_name:'com.codenote.paperchat'}},
      api_key:[{current_key:sampleApiKey}],oauth_client:[{client_id:'not-public-here'}]}
  ],extra_private_field:'excluded'});
}
const missingFiles={GOOGLE_APPLICATION_CREDENTIALS:'/not-mounted/test.json',APNS_KEY_PATH:'/not-mounted/test.p8'};
test('Render 환경변수만으로 FCM 서명과 Android 앱 공개 설정을 함께 제공한다',async()=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const credentials=JSON.stringify({project_id:'paperchat-qa',client_email:'qa@example.invalid',
    private_key:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const env={...missingFiles,FIREBASE_ANDROID_CONFIG_JSON:androidJson(),FCM_SERVICE_ACCOUNT_JSON:credentials};
  const provider=pushProvider(env,async(url,req)=>{
    if(url.endsWith('/token')){
      assert.equal(signed(req.body.get('assertion'),keys.publicKey).iss,'qa@example.invalid');
      return Response.json({access_token:'qa',expires_in:3600});
    }
    assert.equal(url,'https://fcm.googleapis.com/v1/projects/paperchat-qa/messages:send');
    return Response.json({});
  });
  assert.deepEqual(provider.androidClient,{projectId:'paperchat-qa',appId:sampleAppId,senderId:'123456789',apiKey:sampleApiKey});
  assert.equal(provider.enabled('android'),true);
  assert.equal(await provider.send({platform:'android',token:'qa'},'event',()=>true),'sent');
  const wrong=pushProvider({...env,FIREBASE_ANDROID_CONFIG_JSON:androidJson().replace('paperchat-qa','different-project')});
  assert.equal(wrong.androidClient,null);assert.equal(wrong.enabled('android'),false);
});

test('Apple 운영·개발 환경변수와 개행 형식을 각각 읽고 해당 키로 서명한다',async()=>{
  const prod=generateKeyPairSync('ec',{namedCurve:'P-256'}),dev=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const ecPem=keys=>keys.privateKey.export({type:'pkcs8',format:'pem'});
  const env={...missingFiles,APNS_TEAM_ID:'TESTTEAM',APNS_KEY_ID:'production',APNS_DEV_KEY_ID:'development',
    APNS_PRIVATE_KEY:ecPem(prod),APNS_DEV_PRIVATE_KEY:ecPem(dev).replaceAll('\n','\\n')};
  const hosts=[];
  const provider=pushProvider(env,undefined,async(host,headers)=>{
    hosts.push(host);
    const token=headers.authorization.slice(7);
    const sandbox=host==='api.sandbox.push.apple.com';
    assert.equal(JSON.parse(Buffer.from(token.split('.')[0],'base64url')).kid,sandbox?'development':'production');
    assert.equal(signed(token,(sandbox?dev:prod).publicKey,true).iss,'TESTTEAM');
    return {status:200};
  });
  for(const platform of ['ios-dev','ios-prod']){
    assert.equal(provider.enabled(platform),true);
    assert.equal(await provider.send({platform,token:'abcd'},'event',()=>true),'sent');
  }
  assert.deepEqual(hosts,['api.sandbox.push.apple.com','api.push.apple.com']);
});

test('푸시 설정 전에도 실행되고 잘못된 값을 로그에 노출하지 않는다',t=>{
  const warnings=[];
  t.mock.method(console,'warn',(...args)=>warnings.push(args.join(' ')));
  const unset=pushProvider(missingFiles);
  assert.equal(unset.androidClient,null);
  for(const platform of ['ios-dev','ios-prod','android'])assert.equal(unset.enabled(platform),false);
  const bad=pushProvider({...missingFiles,FCM_SERVICE_ACCOUNT_JSON:'bogus-secret-marker',APNS_TEAM_ID:'T',
    APNS_KEY_ID:'K',APNS_PRIVATE_KEY:'bogus-secret-marker',FIREBASE_ANDROID_CONFIG_JSON:androidJson().replace('com.codenote.paperchat','other.app')});
  assert.equal(bad.androidClient,null);assert.equal(bad.enabled('android'),false);assert.equal(bad.enabled('ios-prod'),false);
  assert.equal(warnings.length,3);assert.ok(warnings.every(line=>!line.includes('bogus-secret-marker')));
});
