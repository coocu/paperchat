import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext,runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { policyVersion,reasons,rules } from '../public/rules.js';
import { privacyEffectiveDate,privacyIntro,privacySections } from '../public/privacy.js';

// Exercise the actual WebView controller with an isolated DOM and HTTP adapter.
// The real native shells use the same controller.
const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  .replace(/^import [^\n]+\n/gm,'').replace('start().catch(', 'Promise.resolve().catch(');
function browser({version,search='',userAgent='',pathname='/app',EventSource,instantSplash=false,navigatorProps={},windowProps={},fetchReply}){
  const nodes=new Map(),local=new Map(),session=new Map(),intervals=new Map(),events=new Map();let timerId=0,dialogId=0;
  if(version)local.set('paperchat.reset',version);
  function element(k){
    if(!nodes.has(k))nodes.set(k,{
      innerHTML:'',textContent:'',hidden:true,handlers:{},options:[],value:'',attributes:{},scrollHeight:100,scrollTop:100,clientHeight:100,
      classList:{toggle(){}},
      querySelector(selector){
        if(selector.startsWith('[data-message='))return {remove:()=>{this.innerHTML=this.innerHTML.replace(new RegExp('<article[^>]*data-message="'+selector.match(/"(\d+)"/)[1]+'"[\\s\\S]*?</article>'),'');}};
        return element(selector);
      },
      append(){},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},remove(){this.open=false;},
      setAttribute(k,v){this.attributes[k]=v;},
      add(option){this.options.push(option);if(this.options.length===1)this.value=option.value;},
      addEventListener(e,cb){this.handlers[e]=cb;},
      insertAdjacentHTML(where,html){this.innerHTML+=html;},
      replaceChildren(){this.innerHTML='';this.options=[];this.value='';}
    });
    return nodes.get(k);
  }
  const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),clear:()=>map.clear()});
  const location={pathname,search,replacements:[],replace(url){this.redirect=url;this.replacements.push(url);}};
  const history={replaceState(state,title,url){this.replaced=url;}};
  const ctx=createContext({document:{querySelector:s=>s==='dialog[open]'?[...nodes.values()].find(el=>el.open)||null:element(s),querySelectorAll:s=>s==='dialog[open]'?[...nodes.values()].filter(el=>el.open):[],createElement:tag=>element(tag+ ++dialogId),hidden:false,addEventListener:(name,fn)=>events.set(name,fn)},navigator:{userAgent,...navigatorProps},
    location,history,matchMedia:()=>({matches:true}),window:{EventSource,addEventListener:(name,fn)=>events.set(name,fn),scrollTo(){},...windowProps},setInterval:(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:(fn,ms)=>{if(instantSplash&&ms<=1300)queueMicrotask(fn);return 7;},clearTimeout,AbortController,
    policyVersion,reasons,rules,privacyEffectiveDate,privacyIntro,privacySections,sessionStorage:storage(session),localStorage:storage(local),
    Option:class { constructor(text,value){this.text=text;this.value=value;} },
    FormData:class { constructor(form){this.form=form;}get(key){return this.form.values?.[key]??'';} },
    URL,URLSearchParams,atob,fetch:async(url,options)=>{const r=await fetchReply(url,options),status=r?.$status||200;return {ok:status>=200&&status<300,status,headers:{get:k=>k==='X-Service-Version'?r?.version:k==='X-Room-Version'?r?.$roomVersion:null},json:async()=>r?.$body??r};}});
  runInContext(script,ctx);
  return {run:code=>runInContext(code,ctx),element,local,location,history,session,intervals,events};
}
test('열린 앱에서 초기화를 감지하면 현재 화면과 가입 초안을 지우고 사용자 정보 없음 안내로 이동한다',async()=>{
  const b=browser({version:'old',fetchReply:()=>({version:'fresh',stage:'gate'})});
  b.element('#app').innerHTML='이전 회원의 대화';b.session.set('draft','이전 정보');
  b.run("stage='member';me={nick:'이전 회원'};draft.memo='입력중';scopes.people.area='경기도 이천시'");
  await b.run('pulse(true)');
  assert.equal(b.location.redirect,'/app?reset=1');assert.equal(b.element('#app').innerHTML,'');assert.equal(b.session.size,0);
  assert.equal(b.run('me'),null);assert.equal(b.run('draft.memo'),'');assert.equal(b.local.get('paperchat.reset'),'fresh');
  const reloaded=browser({version:'fresh',search:'?reset=1',fetchReply:()=>({version:'fresh',stage:'gate'})});
  await reloaded.run('boot()');assert.match(reloaded.element('#error').textContent,/등록된 사용자 정보가 없습니다/);
});

test('웹 루트와 앱 호환 경로는 회원 인증·프로필 화면으로 시작하고 관리자 API를 호출하지 않는다',async()=>{
  for(const pathname of ['/','/app'])for(const signedIn of [false,true]){
    const requests=[];
    const b=browser({pathname,instantSplash:true,fetchReply:url=>{
      requests.push(url);
      if(url==='/api/people')return [];
      if(url==='/api/unread')return {total:0};
      return signedIn?{stage:'member',profile:{id:'self',nick:'회원',area:'서울 동부'}}:{stage:'gate'};
    }});
    await b.run('start()');
    assert.equal(b.run('admin'),false);assert.equal(b.run('memberPath'),pathname);
    assert.equal(requests[0],'/api/status?member=1');assert.ok(requests.includes('/api/state'));
    assert.equal(requests.some(url=>url.startsWith('/api/admin/')),false);
    assert.match(b.element('#app').innerHTML,signedIn?/프로필 목록/:/인증키를 입력해 주세요/);
    assert.equal(b.location.redirect,undefined);
  }
});

test('관리자 화면은 정확한 새 경로에서만 시작하며 로그아웃 후에도 경로를 유지한다',async()=>{
  const requests=[];
  const b=browser({pathname:'/codenotekyh',fetchReply:url=>{requests.push(url);return {};}});
  await b.run('start()');
  assert.equal(b.run('admin'),true);assert.deepEqual(requests,['/api/status','/api/admin/settings']);
  assert.match(b.element('#app').innerHTML,/운영자 관리실/);
  await b.element('#out').handlers.click({});
  assert.equal(requests.at(-1),'/api/admin/logout');assert.match(b.element('#app').innerHTML,/관리자 로그인/);
  assert.equal(b.location.pathname,'/codenotekyh');assert.equal(b.location.redirect,undefined);
  for(const pathname of ['/admin','/admin/','/codenotekyh-extra'])assert.equal(browser({pathname,fetchReply:()=>({})}).run('admin'),false);
});

test('회원 로그아웃과 탈퇴는 웹 루트 및 앱 경로를 각각 유지한다',async()=>{
  for(const pathname of ['/','/app'])for(const action of ['logout','withdraw']){
    const requests=[];
    const b=browser({pathname,fetchReply:(url,options)=>{requests.push([url,JSON.parse(options.body)]);return {};}});
    b.run("stage='member';me={id:'self',nick:'회원'};settings()");
    await b.element('#'+action).handlers.click({});
    if(action==='withdraw')await b.element('#proceed').onclick();
    assert.deepEqual(requests,[['/api/'+action,action==='withdraw'?{confirm:true}:{}]]);
    assert.equal(b.location.redirect,pathname);
  }
});

test('서버 초기화는 현재 회원 또는 관리자 진입 경로로 돌아간다',async()=>{
  for(const pathname of ['/','/app','/codenotekyh']){
    const b=browser({pathname,version:'old',fetchReply:()=>({version:'fresh',stage:'gate'})});
    b.element('#app').innerHTML='이전 화면';b.run("draft.memo='작성 중'");
    await b.run('pulse(true)');
    assert.equal(b.location.redirect,pathname+'?reset=1');assert.equal(b.element('#app').innerHTML,'');assert.equal(b.run('draft.memo'),'');
  }
});

test('알림 진입의 inbox query를 지울 때 웹 루트와 앱 경로를 유지한다',async()=>{
  for(const pathname of ['/','/app']){
    const requests=[];
    const b=browser({pathname,search:'?inbox=1',fetchReply:url=>{
      requests.push(url);if(url==='/api/rooms')return [];if(url==='/api/unread')return {total:0};
      return {stage:'member',profile:{id:'self',nick:'회원'}};
    }});
    await b.run('boot()');
    assert.equal(b.history.replaced,pathname);assert.match(b.element('#app').innerHTML,/내 대화/);
    assert.ok(requests.includes('/api/rooms'));assert.equal(requests.includes('/api/people'),false);
  }
});

test('일반 브라우저는 네이티브 푸시 연결을 요청하거나 설정 기능을 노출하지 않는다',async()=>{
  for(const pathname of ['/','/app']){
    const requests=[];const b=browser({pathname,userAgent:'Mozilla/5.0',fetchReply:url=>{requests.push(url);return {};}});
    b.run("stage='member';me={id:'self',nick:'회원'};settings()");await b.run('syncPush(true)');
    assert.deepEqual(requests,[]);assert.equal(b.location.href,undefined);
    assert.doesNotMatch(b.element('#app').innerHTML+b.element('#sections').innerHTML,/push-settings|push-check|캡처가 차단|스크린샷이 차단/);
  }
});

test('네이티브 뒤로가기는 상세에서 목록으로 이동하고 첫 화면에서는 종료를 요청하지 않는다',async()=>{
  const requests=[];
  const b=browser({fetchReply:url=>{requests.push(url);return [];}});
  b.run("me={id:'self'};profile({id:'other',nick:'봄',area:'경기도 이천시'})");
  assert.equal(b.run('window.paperChatBack()'),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[0],'/api/people');
  assert.equal(b.run('window.paperChatBack()'),false);
  b.run('settings()');
  assert.equal(b.run('window.paperChatBack()'),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.at(-1),'/api/people');
});

test('업데이트한 Android 앱도 푸시 연결을 요청한다',async()=>{
  const b=browser({userAgent:'Mobile PaperChatAndroid/3',fetchReply:()=>({})});
  b.run("stage='member'");await b.run('syncPush(true)');
  assert.equal(b.location.href,'paperchat://push/sync');
});

test('프로필이 비공개인 제한 계정에도 서버가 준 제한 종료 시각을 표시한다',async()=>{
  const b=browser({fetchReply:()=>({stage:'restricted',profile:null,restrictedUntil:Date.UTC(2026,10,27,9)})});
  await b.run('boot()');assert.match(b.element('#app').innerHTML,/이용 재개:/);
});

test('안 읽은 개수를 메뉴와 방에 표시하고 모두 읽으면 메뉴 배지를 숨긴다',async()=>{
  let total=4;
  const b=browser({fetchReply:()=>({total})});b.run("stage='member'");
  await b.run('syncUnread()');
  assert.match(b.run("tabs('people')"),/안 읽은 메시지 4개/);
  assert.match(b.run("row('r','봄','경기도 이천시',2)"),/안 읽은 메시지 2개/);
  total=0;await b.run('syncUnread()');assert.equal(b.element('#unread-total').hidden,true);
});
test('앱 복귀 시 서버 확인 실패는 이전 내용을 가리고 정상 연결 후 재표시한다',async()=>{
  let offline=true;const b=browser({version:'one',fetchReply:()=>{
    if(offline)throw new Error('offline');return {stage:'member',version:'one'};
  }});
  b.run("stage='member';me={nick:'보관된 회원'}");
  await b.run('pulse(true)');assert.equal(b.element('#lockscreen').hidden,false);assert.equal(b.element('#app').inert,true);
  offline=false;await b.run('pulse(true)');
  assert.equal(b.element('#lockscreen').hidden,true);assert.equal(b.location.redirect,undefined);assert.equal(b.run('me.nick'),'보관된 회원');
});
test('운영자의 발신자 상세 이동은 닉네임이 같아도 선택된 발신자 ID를 사용한다',async()=>{
  const paths=[];
  const b=browser({version:'one',fetchReply:url=>{paths.push(url);return {id:'sender-2',nick:'동명이인',area:'경기도 이천시',contact:{name:'검증회원2',phone:'01000000002'}};}});
  b.run("reviewItem({id:9,sender:'sender-2',nick:'동명이인',area:'경기도 이천시',expires:9999999999999},true)");
  assert.match(b.element('#app').innerHTML,/가입자 정보 보기/);
  await b.element('#sender').handlers.click({});
  assert.deepEqual(paths,['/api/admin/members/sender-2']);
  assert.match(b.element('#app').innerHTML,/검증회원2/);assert.match(b.element('#app').innerHTML,/01000000002/);
});

test('가입키 화면의 카드 간격, 기존 회원 로그인과 직접 입력 화면을 확인한다',async()=>{
  const requests=[];
  const b=browser({version:'one',fetchReply:url=>{requests.push(url);return {stage:'gate',version:'one'};}});
  await b.run('boot()');
  const gate=b.element('#app').innerHTML;
  assert.match(gate,/class="screen-stack"/);
  assert.equal((gate.match(/id="error"/g)||[]).length,1);
  assert.match(gate,/인증하고 계속[\s\S]*기존 회원 로그인[\s\S]*인증키 발급 안내[\s\S]*이용규칙/);
  assert.match(gate,/현재 승인된 인증키로 다음 가입 단계로 이동/);assert.match(gate,/같은 인증키를 사용해도 회원 계정은 각각 만들어/);
  assert.match(gate,/기존 계정은 개인 복구코드로 로그인/);assert.doesNotMatch(gate,/다시 활성화|이미 사용한 인증키/);
  await b.element('#existing').handlers.click({});
  assert.match(b.element('#app').innerHTML,/개인 복구코드/);
  assert.deepEqual(requests,['/api/state']);
  b.run("draft.nick='채팅';details()");
  const page=b.element('#app').innerHTML;
  assert.match(page,/생년월일/);assert.match(page,/type="date"/);assert.match(page,/남자/);assert.match(page,/여자/);
  assert.match(page,/만 19세/);assert.doesNotMatch(page,/전화번호|통신사/);
});

test('가입 인증키 확인이 성공하면 기존 계정 로그인 없이 닉네임 입력 단계로 이동한다',async()=>{
  const requests=[];const b=browser({pathname:'/',fetchReply:(url,options)=>{requests.push([url,JSON.parse(options.body)]);return {stage:'gate_ok'};}});
  b.run('gate()');await submitForm(b,{code:'shared-registration-key'});
  assert.deepEqual(requests,[['/api/key',{code:'shared-registration-key'}]]);
  assert.match(b.element('#app').innerHTML,/어떻게 불러드릴까요/);assert.match(b.element('#app').innerHTML,/id="nick"/);
  assert.doesNotMatch(b.element('#app').innerHTML,/개인 복구코드|id="recovery"/);
});

test('규칙 동의 문구와 설정 카드',()=>{
  const b=browser({fetchReply:()=>({})});
  for(const view of ["memo()","limitedPage('policy')"]){
    b.run(view);
    const label=b.element('#app').innerHTML.match(/<label class="check">([\s\S]*?)<\/label>/)[1];
    assert.equal(label.replace(/<[^>]+>/g,''),'이용규칙에 동의해요');
  }
  b.run("me={nick:'가을',year:1995,gender:'여성',area:'경기도 이천시',memo:''};settings()");
  assert.match(b.element('#sections').innerHTML,/이용규칙/);
  assert.doesNotMatch(b.element('#app').innerHTML+b.element('#sections').innerHTML,/채팅 알림|push-settings|push-check/);
});

test('개인정보 처리방침은 공유 원문의 모든 문단을 앱 안에서 표시한다',async()=>{
  const b=browser({fetchReply:()=>{throw new Error('정책을 읽는 데 요청이 필요하지 않음');}});
  b.run('gate()');assert.match(b.element('#app').innerHTML,/id="privacy"[^>]*>개인정보 처리방침/);
  await b.element('#privacy').handlers.click({});
  const dialog=b.element('dialog1');assert.equal(dialog.open,true);
  assert.equal(dialog.attributes['aria-labelledby'],'privacy-title');
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const intro=Array.isArray(privacyIntro)?privacyIntro:[privacyIntro];
  for(const value of [privacyEffectiveDate,...intro,...privacySections.flatMap(s=>[s.title,...s.paragraphs||[],...s.bullets||[]])])assert.ok(dialog.innerHTML.includes(escape(value)),String(value));
  assert.doesNotMatch(dialog.innerHTML,/<iframe|target="_blank"/);
  assert.equal(b.location.href,undefined);assert.equal(b.location.redirect,undefined);
});

test('가입 중 정책을 열고 네이티브 뒤로가기를 해도 입력·동의·화면 이벤트가 유지된다',async()=>{
  for(const screen of ['gate()','memo()']){
    const b=browser({fetchReply:()=>({})});
    b.run("draft.nick='봄';draft.province='서울';draft.district='동부';draft.memo='초안'");b.run(screen);
    b.element('#code').value='입력 중인 키';b.element('#memo').value='저장 전 소개글';b.element('input[type=checkbox]').checked=true;
    const html=b.element('#app').innerHTML,view=b.run('epoch'),back=b.run('currentBack'),handler=b.element('form').handlers.submit;
    await b.element('#privacy').handlers.click({});
    assert.equal(b.run('epoch'),view);assert.equal(b.run('currentBack'),back);
    assert.equal(b.run('window.paperChatBack()'),true);assert.equal(b.element('dialog1').open,false);
    assert.equal(b.element('#app').innerHTML,html);assert.equal(b.element('form').handlers.submit,handler);
    assert.equal(b.element('#code').value,'입력 중인 키');assert.equal(b.element('#memo').value,'저장 전 소개글');assert.equal(b.element('input[type=checkbox]').checked,true);
    assert.equal(b.run('draft.memo'),'초안');assert.equal(b.run('draft.district'),'동부');
  }
});

test('설정의 독립 개인정보 버튼을 닫으면 설정 화면과 계정 상태를 유지한다',async()=>{
  const b=browser({fetchReply:()=>({})});
  b.run("stage='member';me={id:'a',nick:'가을',year:1995,gender:'여성',area:'서울 동부',memo:'소개'};settings()");
  assert.match(b.element('#app').innerHTML,/<button id="privacy" class="menu /);
  assert.equal((b.element('#app').innerHTML.match(/id="privacy"/g)||[]).length,1);
  assert.doesNotMatch(b.element('#sections').innerHTML,/id="privacy"/);
  const html=b.element('#app').innerHTML,view=b.run('epoch');
  await b.element('#privacy').handlers.click({});b.element('#privacy-close').onclick();
  assert.equal(b.element('dialog1').open,false);assert.equal(b.element('#app').innerHTML,html);assert.equal(b.run('epoch'),view);assert.equal(b.run('stage'),'member');
});

test('정책을 읽는 중 계정이 폐기되면 닫고 이전 설정 대신 인증 화면으로 돌아간다',async()=>{
  const b=browser({fetchReply:()=>({stage:'gate'})});
  b.run("stage='member';me={id:'a',nick:'이전 회원'};settings();privacyPage()");assert.equal(b.element('dialog1').open,true);
  await b.run('pulse(true)');
  assert.equal(b.element('dialog1').open,false);assert.equal(b.run('stage'),'gate');assert.equal(b.run('me'),null);
  assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);assert.doesNotMatch(b.element('#app').innerHTML,/이전 회원/);
});

test('관리자 대화 목록은 전체로 열리고 참여자별 지역을 구분한다',async()=>{
  const paths=[];
  const b=browser({fetchReply:url=>{paths.push(url);return [{id:'r',first:'가을',firstArea:'경기도 이천시',second:'겨울',secondArea:'서울특별시 중구'}];}});
  await b.run('monitor()');
  assert.deepEqual(paths,['/api/admin/rooms']);
  assert.match(b.element('#app').innerHTML,/aria-pressed="true">전체/);
  assert.match(b.element('#list').innerHTML,/가을 \(경기도 이천시\) · 겨울 \(서울특별시 중구\)/);
});

test('프로필과 내 대화는 전체로 시작하고 선택한 권역으로 정확히 전환한다',async()=>{
  for(const entry of ['people','rooms']){
    const requests=[];
    const b=browser({fetchReply:url=>{
      requests.push(url);
      if(url==='/api/regions')return {'경기':['남부','북부'],'서울':['동부','서부','남부','북부','중부']};
      return [{id:'other',nick:'봄',year:1995,gender:'여성',area:'경기 남부'}];
    }});
    b.run("me={area:'경기 남부'}");
    await b.run(entry+'()');
    assert.deepEqual(requests,['/api/'+entry]);
    assert.match(b.element('#list').innerHTML,/경기 남부/);
    await b.element('#scope-area').handlers.click({});
    assert.equal(requests.at(-1),'/api/'+entry+'?area='+encodeURIComponent('경기 남부'));
    b.element('#district').value='북부';b.element('#district').onchange();
    assert.equal(requests.at(-1),'/api/'+entry+'?area='+encodeURIComponent('경기 북부'));
    await b.element('#scope-all').handlers.click({});
    assert.equal(requests.at(-1),'/api/'+entry);
  }
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('프로필은 최근 접속순으로 정렬되고 접속 상태와 순서가 주기 갱신된다',async()=>{
  let latest=10;
  const b=browser({fetchReply:()=>[{id:'a',nick:'먼저 가입',lastSeen:latest,online:false},{id:'b',nick:'나중 가입',lastSeen:20,online:true}]});
  await b.run('people()');
  let html=b.element('#list').innerHTML;
  assert.ok(html.indexOf('나중 가입')<html.indexOf('먼저 가입'));assert.match(html,/presence-badge online">접속 중/);
  latest=30;b.intervals.get(b.run('activeTimer')).fn();await settle();
  html=b.element('#list').innerHTML;assert.ok(html.indexOf('먼저 가입')<html.indexOf('나중 가입'));
});

test('회원 401은 민감 상태를 비우며 늦은 정상 응답도 이전 화면을 복원하지 않는다',async()=>{
  let finishBlocks;
  const b=browser({fetchReply:url=>url==='/api/blocks'?new Promise(resolve=>{finishBlocks=resolve;}):{$status:401,$body:{error:'없는 계정'}}});
  b.run("stage='member';me={id:'a',nick:'개인 정보'};draft.memo='초안';accountState={profile:me};scopes.people.area='서울';unreadTotal=7;settings()");
  b.session.set('draft','private');
  const delayed=b.run('blockedList()');
  await assert.rejects(b.run("api('presence',{online:true})"),e=>e.stale===true);
  finishBlocks([{id:'private',nick:'차단 회원'}]);await assert.rejects(delayed,e=>e.stale===true);
  assert.equal(b.run('me'),null);assert.equal(b.run('stage'),'gate');assert.equal(b.run('draft.memo'),'');assert.equal(b.run('unreadTotal'),0);
  assert.equal(b.run('Object.keys(accountState).length'),0);assert.equal(b.run('scopes.people.area'),'');assert.equal(b.session.size,0);
  assert.equal(b.run('currentBack'),null);assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);assert.doesNotMatch(b.element('#app').innerHTML,/차단 회원|개인 정보/);
});

test('회원 요청에는 화면 계정 헤더를 보내고 상태 확인·의도한 로그인·관리자 요청에서는 제외한다',async()=>{
  const requests=[];const b=browser({pathname:'/',fetchReply:(url,options)=>{requests.push([url,options.headers]);return {};}});
  b.run("stage='member';me={id:'account-a'}");
  await b.run("api('profile',{area:'서울 동부',memo:'소개'})");await b.run("api('state')");
  await b.run("api('status')");await b.run("api('key',{code:'signup'})");await b.run("api('account/login',{code:'recovery'})");await b.run("api('admin/settings')");
  assert.equal(requests[0][1]['X-PaperChat-Member'],'account-a');assert.equal(requests[0][1]['Content-Type'],'application/json');
  assert.equal(requests[1][1]['X-PaperChat-Member'],'account-a');assert.equal(requests[1][1]['Content-Type'],undefined);
  for(const [,headers] of requests.slice(2))assert.equal(headers['X-PaperChat-Member'],undefined);
});

test('다른 탭에서 로그인 계정이 바뀌면 같은 member 상태여도 화면·초안·실시간 연결을 비우고 현재 경로를 다시 연다',async()=>{
  for(const pathname of ['/','/app'])for(const memberId of ['account-b',null]){
    const {sources,EventSource}=eventStreams();
    const b=browser({pathname,EventSource,fetchReply:url=>url.startsWith('/api/status')?{stage:memberId?'member':'gate',memberId}:{total:0}});
    b.run("stage='member';me={id:'account-a',nick:'이전 계정'};accountState={profile:me};draft.memo='전송 전 초안';unreadTotal=4;settings();updatePresence()");await settle();
    b.session.set('draft','이전 비밀');
    await b.run('pulse(true)');
    assert.equal(b.location.redirect,pathname);assert.equal(b.location.replacements.length,1);assert.equal(sources[0].closed,true);
    assert.equal(b.element('#app').innerHTML,'');assert.equal(b.element('#app').inert,true);assert.equal(b.element('#lockscreen').hidden,false);
    assert.equal(b.run('me'),null);assert.equal(b.run('draft.memo'),'');assert.equal(b.run('unreadTotal'),0);assert.equal(b.run('Object.keys(accountState).length'),0);assert.equal(b.session.size,0);
    await b.run('pulse(true)');assert.equal(b.location.replacements.length,1);
  }
});

test('계정 식별자가 같거나 아직 없는 이전 응답은 현재 회원 화면을 불필요하게 초기화하지 않는다',async()=>{
  for(const status of [{stage:'member',memberId:'account-a'},{stage:'member'}]){
    const b=browser({pathname:'/',fetchReply:url=>url.startsWith('/api/status')?status:{total:0}});
    b.run("stage='member';me={id:'account-a',nick:'현재 회원'};settings()");
    await b.run('pulse(true)');assert.equal(b.location.redirect,undefined);assert.equal(b.run('me.id'),'account-a');assert.match(b.element('#app').innerHTML,/현재 회원/);
  }
});

test('프로필이 없는 제한·규칙동의 계정도 state의 회원 식별자로 요청을 묶고 다른 계정으로 바뀌면 비운다',async()=>{
  for(const stage of ['restricted','policy']){
    let memberId='account-a';const requests=[];
    const b=browser({pathname:'/',fetchReply:(url,options)=>{
      requests.push([url,options.headers]);
      return {stage,memberId,profile:null,restrictedUntil:12345};
    }});
    await b.run('boot()');assert.equal(b.run('me'),null);assert.equal(b.run('currentMemberId()'),'account-a');
    await b.run("api('account/recovery')");
    assert.equal(requests.find(([url])=>url==='/api/account/recovery')[1]['X-PaperChat-Member'],'account-a');
    memberId='account-b';await b.run('pulse(true)');
    assert.equal(b.location.redirect,'/');assert.equal(b.element('#app').innerHTML,'');assert.equal(b.run('currentMemberId()'),null);
    assert.equal(requests.find(([url])=>url==='/api/status?member=1')[1]['X-PaperChat-Member'],undefined);
  }
});

test('계정 변경으로 거부된 변경 요청은 즉시 내용을 숨기고 늦은 성공 응답 및 중복 요청을 무시한다',async()=>{
  let finishBlocks;const conflicts=[],requests=[];
  const {sources,EventSource}=eventStreams();
  const b=browser({pathname:'/',EventSource,fetchReply:(url,options)=>{
    requests.push([url,options.headers]);
    if(url==='/api/blocks')return new Promise(resolve=>{finishBlocks=resolve;});
    if(url==='/api/profile')return new Promise(resolve=>{conflicts.push(resolve);});
    return {total:0};
  }});
  b.run("stage='member';me={id:'account-a',nick:'이전 계정'};settings();updatePresence();draft.memo='이전 초안'");await settle();
  const oldView=b.run('blockedList()');
  const first=b.run("api('profile',{area:'서울 동부',memo:'잘못 저장하면 안 됨'})"),second=b.run("api('profile',{area:'서울 동부',memo:'동시 요청'})");
  const rejection={$status:409,$body:{error:'로그인 계정이 변경되었어요.',code:'ACCOUNT_CHANGED'}};
  conflicts[0](rejection);await assert.rejects(first,e=>e.stale===true);
  assert.equal(b.element('#app').innerHTML,'');assert.equal(b.element('#lockscreen').hidden,false);assert.equal(sources[0].closed,true);
  assert.equal(b.run('me'),null);assert.equal(b.run('draft.memo'),'');assert.equal(b.location.redirect,'/');
  conflicts[1](rejection);await assert.rejects(second,e=>e.stale===true);
  finishBlocks([{id:'old-peer',nick:'늦은 예전 계정 목록'}]);await assert.rejects(oldView,e=>e.stale===true);
  assert.equal(b.location.replacements.length,1);assert.equal(b.element('#app').innerHTML,'');
  const before=requests.length;await assert.rejects(b.run("api('profile',{area:'서울 동부',memo:'다시 시도'})"),e=>e.stale===true);assert.equal(requests.length,before);
  for(const [,headers] of requests)assert.equal(headers['X-PaperChat-Member'],'account-a');
});

test('관리자 화면은 일반 회원 계정 변경 응답과 헤더 바인딩의 영향을 받지 않는다',async()=>{
  const requests=[];const b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
    requests.push([url,options.headers]);return url==='/api/status'?{stage:'member',memberId:'account-b',adminSignedIn:true}:{$status:409,$body:{error:'관리자 요청 오류',code:'ACCOUNT_CHANGED'}};
  }});
  b.run("me={id:'account-a'};adminLogin()");const html=b.element('#app').innerHTML;
  await b.run('pulse(true)');await assert.rejects(b.run("api('admin/settings',{url:'https://example.com'})"),e=>e.status===409&&!e.stale);
  assert.equal(b.location.redirect,undefined);assert.equal(b.element('#app').innerHTML,html);assert.equal(b.run('me.id'),'account-a');
  for(const [,headers] of requests)assert.equal(headers['X-PaperChat-Member'],undefined);
});

test('부팅 중 미독 응답을 기다리다 회원이 삭제되어도 가입 화면을 유지한다',async()=>{
  let finishUnread;
  const b=browser({fetchReply:url=>{
    if(url==='/api/state')return {stage:'member',profile:{id:'a',nick:'이전 회원'}};
    if(url==='/api/unread')return new Promise(resolve=>{finishUnread=resolve;});
    if(url==='/api/rooms')return {$status:401,$body:{error:'삭제됨'}};
    return {};
  }});
  const booting=b.run('boot()');await settle();
  await assert.rejects(b.run("api('rooms')"),e=>e.stale===true);
  finishUnread({total:5});await booting;
  assert.equal(b.run('stage'),'gate');assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);
});

test('로그인 실패와 관리자 401은 회원 삭제 초기화로 처리하지 않는다',async()=>{
  for(const pathname of ['/','/app','/codenotekyh']){
    const b=browser({pathname,fetchReply:()=>({$status:401,$body:{error:'코드 확인'}})});
    b.run(pathname==='/codenotekyh'?'adminLogin()':'loginPage()');const html=b.element('#app').innerHTML;
    await assert.rejects(b.run(pathname==='/codenotekyh'?"api('admin/settings')":"api('account/login',{code:'wrong'})"),e=>e.status===401&&!e.stale);
    assert.equal(b.element('#app').innerHTML,html);
  }
});

test('제한 및 규칙 동의 화면도 계정 삭제 상태를 감지해 초기화한다',async()=>{
  for(const stage of ['restricted','policy']){
    const b=browser({fetchReply:()=>({stage:'gate'})});
    b.run(`stage='${stage}';accountState={restrictedUntil:123};draft.memo='old';limitedPage(stage)`);
    await b.run('pulse(true)');
    assert.equal(b.run('stage'),'gate');assert.equal(b.run('draft.memo'),'');assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);
  }
});

test('화면을 바꾼 뒤 늦게 도착한 요청은 새 화면을 덮어쓰지 않는다',async()=>{
  let finish;
  const b=browser({fetchReply:()=>new Promise(resolve=>{finish=resolve;})});
  b.run("stage='member';me={id:'a',nick:'현재 회원'};settings()");
  const request=b.run('blockedList()');b.run('profile({id:"b",nick:"선택한 프로필"})');
  finish([{id:'c',nick:'차단 목록'}]);await assert.rejects(request,e=>e.stale===true);
  assert.match(b.element('#app').innerHTML,/선택한 프로필/);assert.doesNotMatch(b.element('#app').innerHTML,/차단 목록/);
});

test('네이티브 백그라운드에서는 offline을 전송하고 heartbeat·폴링·읽음 처리를 중지한다',async()=>{
  const requests=[];
  const b=browser({fetchReply:(url,options)=>{
    requests.push({url,body:options.body&&JSON.parse(options.body),keepalive:options.keepalive});
    if(url.includes('/messages'))return [{id:1,author:'b',nick:'상대',body:'안녕하세요',sent:1}];
    if(url==='/api/status?member=1')return {stage:'member'};
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'};updatePresence()");await settle();
  assert.ok([...b.intervals.values()].some(t=>t.ms===30000));
  await b.run("conversation('r','대화',false,rooms,'b')");
  b.run('window.paperChatPresence(false)');await settle();
  const offline=requests.at(-1);assert.equal(offline.url,'/api/presence');assert.deepEqual(offline.body,{online:false});assert.equal(offline.keepalive,true);
  assert.equal([...b.intervals.values()].some(t=>t.ms===30000),false);
  requests.length=0;
  for(const timer of b.intervals.values())timer.fn();
  b.element('#log').handlers.scroll();await b.run('syncUnread()');await b.run('syncPush(true)');await settle();
  assert.equal(requests.length,0);assert.equal(b.element('#lockscreen').hidden,false);
  b.run('window.paperChatPresence(true)');await settle();
  assert.ok(requests.some(r=>r.url==='/api/presence'&&r.body.online));assert.ok([...b.intervals.values()].some(t=>t.ms===30000));
});

test('문서 숨김과 pagehide는 offline을 전송하고 pageshow는 온라인을 재개한다',async()=>{
  const requests=[];const b=browser({fetchReply:(url,options)=>{requests.push([url,options.body&&JSON.parse(options.body)]);return {stage:'member'};}});
  b.run("stage='restricted';updatePresence()");await settle();
  b.run('document.hidden=true');b.events.get('visibilitychange')();await settle();assert.deepEqual(requests.at(-1),['/api/presence',{online:false}]);
  b.run('document.hidden=false');b.events.get('pagehide')();await settle();assert.deepEqual(requests.at(-1),['/api/presence',{online:false}]);
  b.events.get('pageshow')({persisted:false});await settle();assert.deepEqual(requests.at(-1),['/api/presence',{online:true}]);
});

test('내 메시지 삭제는 양쪽에서 사라짐을 확인하고 즉시 제거하며 늦은 폴링에도 다시 나타나지 않는다',async()=>{
  const own={id:1,author:'a',nick:'나',body:'삭제할 메시지',sent:1};const requests=[];
  const b=browser({fetchReply:(url,options)=>{requests.push([url,options.body]);if(url.includes('/messages'))return [own];return {total:0};}});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',false,rooms,'b')");
  assert.match(b.element('#log').innerHTML,/data-delete-message="1"/);
  await b.element('#log').handlers.click({target:{closest:s=>s==='[data-delete-message]'?{dataset:{deleteMessage:'1'}}:null}});
  assert.match(b.element('dialog1').innerHTML,/양쪽 대화에서 사라져요/);assert.match(b.element('dialog1').innerHTML,/사진은 전송 후 12시간/);assert.doesNotMatch(b.element('dialog1').innerHTML,/관리자|운영자/);
  await b.element('#proceed').onclick();assert.doesNotMatch(b.element('#log').innerHTML,/삭제할 메시지/);
  assert.ok(requests.some(([url,body])=>url==='/api/messages/1/delete'&&body==='{"confirm":true}'));
  b.intervals.get(b.run('activeTimer')).fn();await settle();assert.doesNotMatch(b.element('#log').innerHTML,/삭제할 메시지/);
});

test('상대방 삭제 tombstone은 기존 대화에서 사라지며 삭제만 있는 페이지도 과거 대화로 이동한다',async()=>{
  let deleted=false;const paths=[];
  const b=browser({fetchReply:url=>{
    paths.push(url);
    if(url.includes('?before=61'))return Array.from({length:60},(_,i)=>({id:i+1,author:'b',deleted:true,visibility:'deleted'}));
    if(url.includes('?before=1'))return [{id:0,author:'b',body:'가장 오래된 대화',sent:1}];
    if(url.includes('/messages'))return deleted?Array.from({length:60},(_,i)=>({id:i+61,author:'b',deleted:true,visibility:'deleted'})):[{id:90,author:'b',nick:'상대',body:'곧 삭제할 메시지',sent:1}];
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',false,rooms,'b')");assert.match(b.element('#log').innerHTML,/곧 삭제할 메시지/);
  deleted=true;b.intervals.get(b.run('activeTimer')).fn();await settle();assert.doesNotMatch(b.element('#log').innerHTML,/곧 삭제할 메시지/);
  await b.element('#older').handlers.click({});assert.equal(paths.includes('/api/rooms/r/messages?before=61'),true);
  await b.element('#older').handlers.click({});assert.equal(paths.includes('/api/rooms/r/messages?before=1'),true);assert.match(b.element('#log').innerHTML,/가장 오래된 대화/);
});

test('관리자는 기존 대화에서 삭제된 채팅·사진을 구분하며 만료 사진은 열지 않는다',async()=>{
  const b=browser({pathname:'/codenotekyh',fetchReply:()=>[
    {id:4,room:'r',author:'a',nick:'보낸이',body:'보관할 원문',sent:1,deleted:true,deletedAt:2},
    {id:5,room:'r',author:'a',nick:'보낸이',expires:Date.now()+60000,viewable:1,visibility:'visible',sent:1,deleted:true,deletedAt:2},
    {id:6,room:'r',author:'a',nick:'보낸이',expires:1,viewable:1,visibility:'visible',sent:1,deleted:true,deletedAt:2}
  ]});
  await b.run("conversation('r','관리자 대화',true,monitor)");
  const html=b.element('#log').innerHTML;assert.match(html,/보관할 원문/);assert.match(html,/>삭제된 채팅<\/span>/);assert.match(html,/>삭제된 사진<\/span>/);assert.match(html,/\/api\/admin\/photos\/5/);assert.doesNotMatch(html,/\/api\/admin\/photos\/6/);assert.match(html,/보관 기간이 지난 사진/);
  assert.doesNotMatch(b.run("message({id:1,deleted:true,visibility:'deleted',body:null},false)"),/article/);
  assert.match(b.run("message({id:1,deleted:true,visibility:'removed',body:null},true)"),/이용규칙에 따라 삭제/);
  await b.run('adminHome()');assert.doesNotMatch(b.element('#app').innerHTML,/deletedMessages|삭제된 대화내역/);assert.equal(b.run('typeof deletedMessagesPage'),'undefined');
});

test('관리자는 30일 미접속 목록과 상세에서 회원 삭제를 확인하고 목록으로 돌아온다',async()=>{
  const paths=[];const b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
    paths.push([url,options.body]);
    if(url==='/api/admin/members/a')return {id:'a',nick:'오래된 회원',status:'active',lastSeen:1,online:false};
    if(url.endsWith('/delete'))return {};
    return {items:[{id:'a',nick:'오래된 회원',status:'active',lastSeen:1,online:false}],more:false,counts:{active:1,inactive:1,withdrawn:0}};
  }});
  await b.run("membersPage(0,null,'inactive')");assert.equal(paths[0][0],'/api/admin/members?offset=0&filter=inactive');assert.match(b.element('#app').innerHTML,/30일 미접속 회원/);assert.match(b.element('#app').innerHTML,/data-delete-member="a"/);
  await b.run("memberDetail('a',()=>membersPage(0,null,'inactive'))");assert.match(b.element('#app').innerHTML,/id="deleteMember"/);
  await b.element('#deleteMember').handlers.click({});await b.element('#proceed').onclick();
  assert.ok(paths.some(([url,body])=>url==='/api/admin/members/a/delete'&&body==='{"confirm":true}'));assert.match(b.element('#app').innerHTML,/30일 미접속 회원/);
});

test('채팅 나가기는 양쪽 삭제를 확인하고 내용을 즉시 비우며 늦은 폴링에도 복원하지 않는다',async()=>{
  let count=0,finishPoll;const paths=[];
  const original=[{id:1,author:'b',nick:'상대',body:'이전 대화',sent:1}];
  const b=browser({fetchReply:(url,options)=>{
    paths.push([url,options.body]);
    if(url==='/api/rooms/r/messages')return ++count===1?original:new Promise(resolve=>{finishPoll=resolve;});
    if(url==='/api/rooms')return [];
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");b.element('#body').value='입력 중';
  b.intervals.get(b.run('activeTimer')).fn();await settle();
  await b.element('#leaveRoom').handlers.click({});assert.match(b.element('dialog1').innerHTML,/나와 상대방의 채팅방이 모두 삭제/);assert.match(b.element('dialog1').innerHTML,/사진은 전송 후 12시간/);
  await b.element('#proceed').onclick();
  assert.ok(paths.some(([url,body])=>url==='/api/rooms/r/leave'&&body==='{"confirm":true}'));
  assert.equal(b.element('#log').innerHTML,'');assert.equal(b.element('#body').value,'');assert.match(b.element('#app').innerHTML,/내 대화/);
  finishPoll(original);await settle();assert.equal(b.element('#log').innerHTML,'');assert.doesNotMatch(b.element('#app').innerHTML,/id="leaveRoom"/);
});

test('채팅에서 차단하면 대화와 입력을 비우고 내 대화로 돌아온다',async()=>{
  const b=browser({fetchReply:url=>url==='/api/rooms/r/messages'?[{id:1,author:'b',body:'차단할 대화',sent:1}]:url==='/api/rooms'?[]:{total:0}});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");b.element('#body').value='전송 전';
  await b.element('#block').handlers.click({});assert.match(b.element('dialog1').innerHTML,/두 사람의 채팅방이 삭제/);await b.element('#proceed').onclick();
  assert.equal(b.element('#log').innerHTML,'');assert.equal(b.element('#body').value,'');assert.match(b.element('#app').innerHTML,/내 대화/);
});

test('상대가 종료한 방의 폴링·읽음·텍스트·사진 요청 오류는 현재 대화를 비운다',async()=>{
  for(const operation of ['poll','read','text','photo']){
    let closed=false;
    const b=browser({fetchReply:(url,options)=>{
      if(url==='/api/rooms')return [];
      if(closed&&(url.endsWith('/messages')||url.endsWith('/read')))return {$status:operation==='poll'?410:404,$body:{error:'종료된 대화방이에요.'}};
      if(url.endsWith('/messages'))return [{id:1,author:'b',body:'민감한 대화',sent:1}];
      return {total:0};
    }});
    b.run("stage='member';me={id:'a'}");
    if(operation==='read')b.run('nativeForeground=false');
    await b.run("conversation('r','상대',false,rooms,'b')");b.element('#body').value='아직 보내지 않은 글';closed=true;
    if(operation==='poll')b.intervals.get(b.run('activeTimer')).fn();
    if(operation==='read'){b.run('nativeForeground=true');b.element('#log').handlers.scroll();}
    if(operation==='text'){const form=b.element('form');form.values={body:'전송'};await form.handlers.submit({preventDefault(){},currentTarget:form});}
    if(operation==='photo'){b.run("jpeg=async()=> 'jpeg-data'");await b.element('#photo').handlers.change({target:{files:[{size:1}],value:'photo'}});}
    await settle();assert.equal(b.element('#log').innerHTML,'',operation);assert.equal(b.element('#body').value,'',operation);assert.match(b.element('#app').innerHTML,/내 대화/,operation);assert.match(b.element('#notice').textContent,/종료된 채팅방/,operation);
  }
});

test('방의 이용 제한 403은 계정 제한 화면으로 이동하고 방 종료로 오인하지 않는다',async()=>{
  let restricted=false;const b=browser({fetchReply:url=>{
    if(url.endsWith('/messages'))return restricted?{$status:403,$body:{error:'이용 제한'}}:[{id:1,author:'b',body:'대화',sent:1}];
    if(url==='/api/status?member=1'||url==='/api/state')return {stage:'restricted',restrictedUntil:12345};
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");restricted=true;
  b.intervals.get(b.run('activeTimer')).fn();await settle();assert.match(b.element('#app').innerHTML,/계정 이용 제한/);assert.doesNotMatch(b.element('#notice').textContent,/종료된 채팅방/);
});

function eventStreams(){
  const sources=[];
  class EventSource{
    constructor(url){this.url=url;this.handlers={};this.closed=false;sources.push(this);}
    addEventListener(name,fn){this.handlers[name]=fn;}
    close(){this.closed=true;}
    emit(name,data){this.handlers[name]?.({data:JSON.stringify(data)});}
  }
  return {sources,EventSource};
}

test('실시간 삭제는 해당 메시지만 제거하고 작성 중 글을 보존하며 종료는 즉시 방 목록으로 이동한다',async()=>{
  const {sources,EventSource}=eventStreams();
  const b=browser({EventSource,fetchReply:url=>{
    if(url.endsWith('/messages'))return {$roomVersion:'1',$body:[{id:1,author:'b',body:'실시간 삭제할 내용',sent:1}]};
    if(url==='/api/rooms')return [];
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'};updatePresence()");await b.run("conversation('r','상대',false,rooms,'b','',1)");b.element('#body').value='작성 중인 글';
  sources[0].emit('room-change',{room:'r',closed:false,deletedMessage:1,version:2});
  assert.doesNotMatch(b.element('#log').innerHTML,/실시간 삭제할 내용/);assert.equal(b.element('#body').value,'작성 중인 글');
  sources[0].emit('open');await settle();assert.doesNotMatch(b.element('#log').innerHTML,/실시간 삭제할 내용/);assert.equal(b.element('#body').value,'작성 중인 글');
  sources[0].emit('room-change',{room:'unrelated',closed:true,version:99});assert.match(b.element('#app').innerHTML,/id="leaveRoom"/);
  sources[0].emit('room-change',{room:'r',closed:true,version:3});assert.equal(b.element('#log').innerHTML,'');assert.equal(b.element('#body').value,'');assert.match(b.element('#app').innerHTML,/내 대화/);await settle();
});

test('재개한 방은 초기 조회 전에도 과거 종료 이벤트를 무시한다',async()=>{
  const {sources,EventSource}=eventStreams();let finish;
  const b=browser({EventSource,fetchReply:url=>url.endsWith('/messages')?new Promise(resolve=>{finish=resolve;}):{total:0}});
  b.run("stage='member';me={id:'a'};updatePresence()");const opening=b.run("conversation('r','새 대화',false,rooms,'b','',8)");
  sources[0].emit('room-change',{room:'r',closed:true,version:7});assert.match(b.element('#app').innerHTML,/id="leaveRoom"/);
  finish({$roomVersion:'8',$body:[]});await opening;assert.match(b.element('#app').innerHTML,/새 대화/);
});

test('실시간 방 종료는 목록에서 즉시 제거하고 오래된 목록 응답을 무시한다',async()=>{
  const {sources,EventSource}=eventStreams();let count=0,finishOld,finishFresh;
  const item={id:'r',nick:'사라질 방',area:'서울',version:1};
  const b=browser({EventSource,fetchReply:url=>{
    if(url==='/api/rooms')return ++count===1?[item]:new Promise(resolve=>{if(count===2)finishOld=resolve;else finishFresh=resolve;});
    return {total:0};
  }});
  b.run("stage='member';me={id:'a'};updatePresence()");await b.run('rooms()');b.intervals.get(b.run('activeTimer')).fn();await settle();
  sources[0].emit('room-change',{room:'r',closed:true,version:2});assert.doesNotMatch(b.element('#list').innerHTML,/사라질 방/);
  finishOld([item]);await settle();assert.doesNotMatch(b.element('#list').innerHTML,/사라질 방/);finishFresh([]);await settle();
});

test('실시간 연결은 백그라운드·계정 초기화·로그아웃 시 닫고 이전 연결 이벤트를 무시한다',async()=>{
  const {sources,EventSource}=eventStreams();const b=browser({EventSource,fetchReply:url=>url==='/api/rooms'?[]:{stage:'member',total:0}});
  b.run("stage='member';me={id:'a'};updatePresence()");assert.equal(sources[0].url,'/api/events');
  b.run('window.paperChatPresence(false)');assert.equal(sources[0].closed,true);
  b.run('window.paperChatPresence(true)');await settle();assert.equal(sources.length,2);
  b.run('clearMemberSession()');assert.equal(sources[1].closed,true);sources[1].emit('room-change',{room:'r',closed:true,version:99});assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);
  b.run("stage='member';me={id:'new'};updatePresence();settings()");await b.element('#logout').handlers.click({});assert.equal(sources[2].closed,true);assert.equal(b.location.redirect,'/app');
});

const profileRegions={'서울':['동부','서부','남부','북부','중부'],'경기':['남부','북부'],'부산':['전체']};
const currentProfile={id:'self',nick:'가을',year:1995,gender:'여성',area:'경기 남부',memo:'처음 소개글'};
function editingBrowser(reply,profile=currentProfile){
  const requests=[];
  const b=browser({fetchReply:(url,options)=>{
    requests.push([url,options.body&&JSON.parse(options.body)]);
    if(url==='/api/regions')return profileRegions;
    if(url==='/api/state')return {stage:'member',profile};
    return reply(url,options);
  }});
  b.run(`stage='member';me=${JSON.stringify(currentProfile)};accountState={stage,profile:me};settings()`);
  return {...b,requests};
}
function submitForm(b,values){const form=b.element('form');form.values=values;return form.handlers.submit({preventDefault(){},currentTarget:form});}

test('프로필 편집은 최신 소개글을 불러오고 지역·소개글만 저장해 서버 응답을 표시한다',async()=>{
  const latest={...currentProfile,memo:'다른 기기에서 바꾼 소개글'},saved={...currentProfile,area:'서울 동부',memo:'서버에서 확인한 소개글'};
  const b=editingBrowser(()=>({profile:saved}),latest);
  await b.element('#editProfile').handlers.click({});
  const html=b.element('#app').innerHTML;
  assert.match(html,/다른 기기에서 바꾼 소개글/);assert.match(html,/당신을 표현해주세요/);assert.match(html,/1995년/);assert.match(html,/여성/);
  assert.doesNotMatch(html,/<(?:input|select)[^>]*(?:name|id)="(?:nick|birthDate|year|gender)"/);
  assert.equal(b.element('#province').value,'경기');assert.equal(b.element('#district').value,'남부');
  b.element('#province').value='서울';b.element('#province').onchange();b.element('#district').value='동부';
  await submitForm(b,{memo:'  새로 입력한 소개글  ',nick:'변조',gender:'남성',year:'2000'});
  assert.deepEqual(b.requests.find(([url])=>url==='/api/profile')[1],{area:'서울 동부',memo:'새로 입력한 소개글'});
  assert.deepEqual(JSON.parse(b.run('JSON.stringify(me)')),saved);assert.equal(b.run('accountState.profile===me'),true);
  assert.match(b.element('#app').innerHTML,/내 설정/);assert.match(b.element('#app').innerHTML,/서버에서 확인한 소개글/);assert.match(b.element('#notice').textContent,/프로필을 저장/);
});

test('프로필 편집 취소와 뒤로가기는 입력값을 저장하거나 원래 프로필을 변경하지 않는다',async()=>{
  const b=editingBrowser(()=>{throw new Error('저장 요청 금지');});
  for(const cancel of ['button','back']){
    await b.run('editProfile()');b.element('#province').value='부산';b.element('#province').onchange();b.element('#district').value='전체';b.element('#memo').value='저장하지 않을 소개글';
    if(cancel==='button')await b.element('#cancelEdit').handlers.click({});else{b.run('window.paperChatBack()');await settle();}
    assert.deepEqual(JSON.parse(b.run('JSON.stringify(me)')),currentProfile);assert.match(b.element('#app').innerHTML,/처음 소개글/);
  }
  assert.equal(b.requests.some(([url])=>url==='/api/profile'),false);
});

test('알 수 없는 기존 지역은 편집 화면에서 자동 선택하지 않고 새 권역 선택을 요구한다',async()=>{
  const b=editingBrowser(()=>({}),{...currentProfile,area:'지역 미선택'});await b.run('editProfile()');
  assert.equal(b.element('#province').value,'');assert.equal(b.element('#district').value,'');assert.equal(b.element('#district').disabled,true);
  await submitForm(b,{memo:'소개글'});assert.match(b.element('#error').textContent,/지역과 권역을 선택/);assert.equal(b.requests.some(([url])=>url==='/api/profile'),false);
  b.element('#province').value='서울';b.element('#province').onchange();b.element('#district').value='동부';
  await submitForm(b,{memo:'   '});assert.match(b.element('#error').textContent,/소개글을 1자 이상/);assert.equal(b.requests.some(([url])=>url==='/api/profile'),false);
});

test('프로필 저장 오류는 입력을 유지하고 회원 삭제 401은 편집 화면과 계정 상태를 지운다',async()=>{
  for(const status of [400,401]){
    const b=editingBrowser(()=>({$status:status,$body:{error:'저장할 수 없어요.'}}));await b.run('editProfile()');b.element('#memo').value='입력 중인 소개글';
    await submitForm(b,{memo:'입력 중인 소개글'});
    if(status===400){assert.equal(b.element('#memo').value,'입력 중인 소개글');assert.match(b.element('#app').innerHTML,/프로필 편집/);assert.deepEqual(JSON.parse(b.run('JSON.stringify(me)')),currentProfile);assert.match(b.element('#error').textContent,/저장할 수 없어요/);}
    else{assert.equal(b.run('me'),null);assert.equal(b.run('stage'),'gate');assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);assert.doesNotMatch(b.element('#app').innerHTML,/id="memo"/);}
  }
});

test('편집 진입의 늦은 지역 조회와 저장 응답은 이동한 화면이나 프로필을 덮지 않는다',async()=>{
  let finishRegions;
  const b=browser({fetchReply:url=>url==='/api/regions'?new Promise(resolve=>{finishRegions=resolve;}):{stage:'member',profile:currentProfile}});
  b.run(`stage='member';me=${JSON.stringify(currentProfile)};settings()`);const opening=b.run('editProfile()');
  b.run("profile({id:'other',nick:'다른 화면'})");finishRegions(profileRegions);await assert.rejects(opening,e=>e.stale===true);assert.match(b.element('#app').innerHTML,/다른 화면/);
  let finishSave;const editing=editingBrowser(()=>new Promise(resolve=>{finishSave=resolve;}));await editing.run('editProfile()');
  const saving=submitForm(editing,{memo:'새 소개글'});editing.run("profile({id:'other',nick:'선택한 프로필'})");finishSave({profile:{...currentProfile,memo:'늦게 온 소개글'}});await saving;
  assert.match(editing.element('#app').innerHTML,/선택한 프로필/);assert.deepEqual(JSON.parse(editing.run('JSON.stringify(me)')),currentProfile);
});

test('새 지역 목록에 없는 이전 조회 범위는 현재 회원의 권역으로 다시 선택한다',async()=>{
  const paths=[];const b=browser({fetchReply:url=>{paths.push(url);return url==='/api/regions'?profileRegions:[];}});
  b.run("me={area:'경기 북부'};scopes.people={regional:true,area:'서울특별시 중구'}");await b.run('people()');
  assert.equal(paths.at(-1),'/api/people?area='+encodeURIComponent('경기 북부'));assert.equal(b.run('scopes.people.area'),'경기 북부');
});

test('프로필 신고는 본 버전을 보내며 변경된 소개글이면 최신 목록에서 다시 확인하게 한다',async()=>{
  const requests=[];
  const b=browser({fetchReply:(url,options)=>{requests.push([url,options.body&&JSON.parse(options.body)]);return url==='/api/report'?{$status:409,$body:{error:'프로필 변경'}}:[];}});
  b.run("stage='member';me={id:'self'};profile({id:'peer',nick:'상대',memo:'봤던 소개글',profileVersion:'seen-version'})");
  await b.element('#report').handlers.click({});await submitForm(b,{reason:'괴롭힘·기타 위반'});
  assert.deepEqual(requests.find(([url])=>url==='/api/report')[1],{kind:'profile',peer:'peer',profileVersion:'seen-version',reason:'괴롭힘·기타 위반'});
  assert.match(b.element('#app').innerHTML,/프로필 목록/);assert.doesNotMatch(b.element('#app').innerHTML,/봤던 소개글/);assert.match(b.element('#error').textContent,/내용을 다시 확인한 뒤 신고/);
});

test('PC 다운로드 버튼은 기존 회원 로그인 아래에서 빈 주소를 안내하고 설정 주소를 안전한 새 창으로 연다',async()=>{
  const requests=[],opened=[];
  const b=browser({pathname:'/',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1',windowProps:{open:(...args)=>opened.push(args)},fetchReply:url=>{requests.push(url);return {androidUrl:'',iosUrl:'https://apps.example/iphone?id=1&lang=ko'};}});
  b.run('gate()');await new Promise(setImmediate);
  const html=b.element('#app').innerHTML;
  assert.ok(html.indexOf('id="existing"')<html.indexOf('id="download-android"'));
  assert.deepEqual(requests,['/api/download-links']);assert.equal(b.element('#download-android').disabled,false);
  await b.element('#download-android').handlers.click({});assert.equal(b.element('#download-status').textContent,'아직 개발 진행중이에요.');assert.deepEqual(opened,[]);
  await b.element('#download-ios').handlers.click({});assert.deepEqual(opened,[['https://apps.example/iphone?id=1&lang=ko','_blank','noopener,noreferrer']]);
});

test('휴대폰·태블릿과 설치 앱은 PC 다운로드 화면과 주소 조회를 모두 생략한다',async()=>{
  for(const input of [
    {userAgent:'Mozilla/5.0 Android Mobile Chrome'},
    {userAgent:'Mozilla/5.0 iPhone Mobile Safari'},
    {userAgent:'Mozilla/5.0 iPad Safari'},
    {userAgent:'Mozilla/5.0 Macintosh Safari',navigatorProps:{platform:'MacIntel',maxTouchPoints:5}},
    {userAgent:'Mozilla/5.0 Linux Chrome',navigatorProps:{userAgentData:{mobile:true}}},
    {userAgent:'Mozilla/5.0 Windows PaperChatAndroid/3'},
    {userAgent:'Mozilla/5.0 Macintosh PaperChatIOS/4'},
    {userAgent:'Mozilla/5.0 Macintosh Safari',windowProps:{paperChatNativeForeground:true}},
    {userAgent:'Mozilla/5.0 Macintosh Safari',windowProps:{webkit:{messageHandlers:{paperChatPush:{}}}}}
  ]){
    const requests=[];const b=browser({...input,fetchReply:url=>{requests.push(url);return {};}});
    b.run('gate()');await new Promise(setImmediate);
    assert.doesNotMatch(b.element('#app').innerHTML,/download-android|download-ios/);assert.deepEqual(requests,[]);
  }
});

test('다운로드 조회 실패는 개발중과 구분하고 늦은 응답은 이동한 화면을 변경하지 않는다',async()=>{
  let failed=true;const b=browser({userAgent:'Mozilla/5.0 Windows Chrome',fetchReply:()=>failed?{$status:503,$body:{error:'실패'}}:{androidUrl:'',iosUrl:''}});
  b.run('gate()');await new Promise(setImmediate);assert.equal(b.element('#download-retry').hidden,false);assert.match(b.element('#download-status').textContent,/불러오지 못/);assert.doesNotMatch(b.element('#download-status').textContent,/개발 진행중/);
  b.element('#code').value='작성 중';failed=false;await b.element('#download-retry').handlers.click({});assert.equal(b.element('#download-retry').hidden,true);assert.equal(b.element('#code').value,'작성 중');assert.equal(b.element('#download-android').disabled,false);
  let release;const late=browser({userAgent:'Mozilla/5.0 Windows Chrome',fetchReply:()=>new Promise(r=>release=r)});
  late.run('gate();loginPage()');const html=late.element('#app').innerHTML;release({androidUrl:'https://download.example/app',iosUrl:''});await new Promise(setImmediate);assert.equal(late.element('#app').innerHTML,html);assert.match(html,/다시 로그인/);
});

test('관리자는 다운로드 주소 두 개를 각각 비워 저장할 수 있고 위험한 URL은 전송하지 않는다',async()=>{
  const writes=[];const b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
    assert.equal(url,'/api/admin/download-links');
    if(options.method==='GET')return {androidUrl:'https://download.example/android',iosUrl:'https://download.example/ios'};
    const body=JSON.parse(options.body);writes.push(body);return body;
  }});
  await b.run('adminDownloadLinks()');const html=b.element('#app').innerHTML;assert.match(html,/id="androidUrl"/);assert.match(html,/id="iosUrl"/);assert.doesNotMatch(html,/<input[^>]*required/);
  const form=b.element('form');form.values={androidUrl:'',iosUrl:'https://download.example/ios'};
  await form.handlers.submit({preventDefault(){},currentTarget:form});assert.deepEqual(writes,[{androidUrl:'',iosUrl:'https://download.example/ios'}]);
  form.values={androidUrl:'javascript:alert(1)',iosUrl:''};await form.handlers.submit({preventDefault(){},currentTarget:form});assert.equal(writes.length,1);assert.match(b.element('#error').textContent,/https:/);
  for(const value of ['https://user:secret@download.example/app','https://download.example/\napp'])assert.throws(()=>b.run(`downloadURL(${JSON.stringify(value)})`));
});

function webPushFixture({permission='granted',requestPermission,registration,publicKey=Buffer.alloc(65,4).toString('base64url')}={}){
  const calls=[],notifier={permission,requestPermission:requestPermission||(()=>{calls.push('permission');return Promise.resolve(notifier.permission);})};
  const sub={options:{applicationServerKey:Buffer.from(publicKey,'base64url')},toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:'fixture',auth:'fixture'}})};
  const ready=registration||{pushManager:{getSubscription:async()=>sub,subscribe:async()=>{calls.push('subscribe');return sub;}}};
  return {calls,notifier,publicKey,sub,windowProps:{isSecureContext:true,Notification:notifier,PushManager:function(){}},navigatorProps:{serviceWorker:{register:async path=>{calls.push(path);return ready;},ready:Promise.resolve(ready)}}};
}
const webReply=url=>url==='/api/people'?[]:url==='/api/unread'?{total:0}:{stage:'member',profile:{id:'web-self',nick:'회원',area:'서울 동부'}};

test('PC·Chrome Android·삼성인터넷 로그인 동작에서 HTTP보다 먼저 권한을 요청하고 별도 활성화 버튼을 넣지 않는다',async()=>{
  for(const userAgent of ['Mozilla/5.0 Macintosh Chrome/145','Mozilla/5.0 Android Mobile Chrome/145','Mozilla/5.0 Android SamsungBrowser/29 Mobile']){
    const events=[];const w=webPushFixture({permission:'default',requestPermission:()=>{events.push('permission');return new Promise(()=>{});}});
    const b=browser({...w,userAgent,pathname:'/',fetchReply:url=>{events.push(url);return webReply(url);}});
    b.run('loginPage()');b.element('form').values={recovery:'fixture'};
    await b.element('form').handlers.submit({preventDefault(){},currentTarget:b.element('form')});
    assert.deepEqual(events.slice(0,2),['permission','/api/account/login']);
    assert.equal(events.filter(v=>v==='permission').length,1);
    assert.doesNotMatch(b.element('#app').innerHTML,/알림 활성화/);
    assert.match(b.element('#app').innerHTML,/프로필 목록/);
  }
});

test('이미 허용된 웹 알림은 자동 로그인 시 서비스워커 구독을 현재 회원에 연결한다',async()=>{
  const w=webPushFixture(),posts=[];
  const b=browser({...w,pathname:'/',fetchReply:(url,options)=>{
    if(url==='/api/push/web-config')return {publicKey:w.publicKey};
    if(url==='/api/push/web'){posts.push(options);return {configured:true};}
    return webReply(url);
  }});
  await b.run('boot()');await b.run('webPushSync');
  assert.equal(w.calls.includes('permission'),false);
  assert.ok(w.calls.includes('/web-push-worker.js'));
  assert.equal(posts.length,1);
  assert.equal(posts[0].headers['X-PaperChat-Member'],'web-self');
  assert.deepEqual(JSON.parse(posts[0].body),{subscription:w.sub.toJSON()});
});

test('차단된 알림은 재요청 없이 서버 연결만 해제하고 로그인과 대화 이용은 유지한다',async()=>{
  const w=webPushFixture({permission:'denied'}),posts=[];
  const b=browser({...w,fetchReply:(url,options)=>{if(url==='/api/push/web')posts.push(JSON.parse(options.body));return webReply(url);}});
  await b.run('boot()');await b.run('webPushSync');b.run('requestWebPushPermission(true)');
  assert.deepEqual(w.calls,[]);assert.deepEqual(posts,[{subscription:null}]);
  assert.match(b.element('#app').innerHTML,/프로필 목록/);
});

test('권한 미결정 자동 로그인은 자동 요청 후 다음 사용자 동작에서 한 번만 재시도한다',async()=>{
  const w=webPushFixture({permission:'default'});
  const b=browser({...w,fetchReply:()=>({})});b.run("stage='member';me={id:'self'};requestWebPushPermission()");
  await new Promise(r=>setImmediate(r));
  await b.events.get('click')({isTrusted:true});await new Promise(r=>setImmediate(r));
  await b.events.get('click')({isTrusted:true});await b.events.get('keydown')({isTrusted:true});
  assert.equal(w.calls.filter(c=>c==='permission').length,2);
});

test('로그아웃이나 계정 변경 후 늦게 완료된 브라우저 구독은 다른 계정에 등록하지 않는다',async()=>{
  let release;const ready=new Promise(r=>release=r),w=webPushFixture(),requests=[];
  w.navigatorProps.serviceWorker.ready=ready;
  const b=browser({...w,fetchReply:url=>{requests.push(url);return {publicKey:w.publicKey};}});
  b.run("stage='member';me={id:'old'};void syncWebPush(true)");
  await new Promise(r=>setImmediate(r));
  b.run("accountRevision++;stage='member';me={id:'new'}");
  release({pushManager:{getSubscription:async()=>w.sub}});await b.run('webPushSync');
  assert.equal(requests.includes('/api/push/web'),false);
});

test('웹 알림은 네이티브 앱·관리자·보안 연결이 아닌 화면에서 실행하지 않는다',async()=>{
  for(const variant of [{userAgent:'PaperChatAndroid/3'},{userAgent:'PaperChatIOS/4'},{pathname:'/codenotekyh'},{native:true},{insecure:true}]){
    const w=webPushFixture({permission:'default'}),requests=[];
    if(variant.native)w.windowProps.paperChatNativeForeground=true;
    if(variant.insecure)w.windowProps.isSecureContext=false;
    const b=browser({...w,...variant,fetchReply:url=>{requests.push(url);return {};}});
    b.run("stage='member';me={id:'self'};requestWebPushPermission(true)");await b.run('syncWebPush(true)');
    assert.deepEqual(w.calls,[]);assert.deepEqual(requests,[]);
  }
});
