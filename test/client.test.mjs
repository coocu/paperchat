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
function browser({version,search='',userAgent='',pathname='/app',EventSource,instantSplash=false,navigatorProps={},windowProps={},urgentReply,clockNow,fetchReply}){
  const nodes=new Map(),local=new Map(),session=new Map(),intervals=new Map(),events=new Map(),timeouts=new Map();let timerId=0,dialogId=0;
  if(version)local.set('paperchat.reset',version);
  function element(k){
    if(!nodes.has(k))nodes.set(k,{
      innerHTML:'',textContent:'',hidden:true,handlers:{},options:[],value:'',attributes:{},dataset:{},children:[],scrollHeight:100,scrollTop:100,clientHeight:100,
      classList:{toggle(){},add(){},remove(){}},
      querySelector(selector){
        if(selector.startsWith('[data-message='))return {remove:()=>{this.innerHTML=this.innerHTML.replace(new RegExp('<article[^>]*data-message="'+selector.match(/"(\d+)"/)[1]+'"[\\s\\S]*?</article>'),'');}};
        return element(selector);
      },
      append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},remove(){this.open=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;},
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
  const ctx=createContext({Date:clockNow?class extends Date {static now(){return clockNow();}}:Date,document:{body:element('body'),querySelector:s=>s==='dialog[open]'?[...nodes.values()].find(el=>el.open)||null:element(s),querySelectorAll:s=>s==='dialog[open]'?[...nodes.values()].filter(el=>el.open):[],createElement:tag=>element(tag+ ++dialogId),hidden:false,addEventListener:(name,fn)=>events.set(name,fn)},navigator:{userAgent,...navigatorProps},
    location,history,matchMedia:()=>({matches:true}),window:{EventSource,addEventListener:(name,fn)=>events.set(name,fn),scrollTo(){},...windowProps},setInterval:(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:(fn,ms)=>{const id=++timerId;timeouts.set(id,{fn,ms});if(instantSplash&&ms<=1300)queueMicrotask(fn);return id;},clearTimeout:id=>timeouts.delete(id),AbortController,
    policyVersion,reasons,rules,privacyEffectiveDate,privacyIntro,privacySections,sessionStorage:storage(session),localStorage:storage(local),
    Option:class { constructor(text,value){this.text=text;this.value=value;} },
    FormData:class { constructor(form){this.form=form;}get(key){return this.form.values?.[key]??'';} },
    URL,URLSearchParams,atob,fetch:async(url,options)=>{const r=await (url==='/api/urgent-announcement'?(typeof urgentReply==='function'?urgentReply(url,options):urgentReply??{enabled:false,title:'긴급공지',body:'',revision:null,publishedAt:null}):fetchReply(url,options)),status=r?.$status||200;return {ok:status>=200&&status<300,status,headers:{get:k=>k==='X-Service-Version'?r?.version:k==='X-Room-Version'?r?.$roomVersion:null},json:async()=>r?.$body??r};}});
  runInContext(script,ctx);
  return {run:code=>runInContext(code,ctx),element,local,location,history,session,intervals,events,timeouts};
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

test('관리자 모니터링은 전체 프로필과 대화방 수를 표시하고 삭제 회원도 구분한다',async()=>{
  const paths=[];
  const b=browser({pathname:'/codenotekyh',fetchReply:url=>{paths.push(url);return [{id:'p',nick:'가을',year:1995,gender:'여성',area:'서울 동부',memo:'편안한 대화',deletedAt:100,roomCount:3,matchedRoomCount:3,recent:123}];}});
  await b.run('monitor()');
  assert.deepEqual(paths,['/api/admin/monitor/profiles']);
  assert.match(b.element('#app').innerHTML,/aria-pressed="true">전체/);
  assert.match(b.element('#list').innerHTML,/가을/);assert.match(b.element('#list').innerHTML,/대화방 3개/);assert.match(b.element('#list').innerHTML,/삭제된 회원/);
  assert.equal(b.element('#monitorCount').textContent,'프로필 1명');
});

test('관리자 검색어는 지역 필터 및 프로필 대화 목록에 보존되고 특수문자는 URL 인코딩된다',async()=>{
 const requests=[],p={id:'self',nick:'봄',year:1995,gender:'여성',area:'서울 동부',memo:'소개'};
 const b=browser({pathname:'/codenotekyh',fetchReply:url=>{requests.push(url);if(url==='/api/regions')return {'서울':['동부','서부']};return [];}});
 b.run("scopes.monitor={query:'100%_ & 봄',regional:true,area:'서울 동부'}");await b.run('monitor()');
 const first=new URL(requests.at(-1),'https://example.com');assert.equal(first.pathname,'/api/admin/monitor/profiles');assert.equal(first.searchParams.get('q'),'100%_ & 봄');assert.equal(first.searchParams.get('area'),'서울 동부');
 await b.run('monitorRooms('+JSON.stringify(p)+')');const rooms=new URL(requests.at(-1),'https://example.com');assert.equal(rooms.pathname,'/api/admin/rooms');assert.equal(rooms.searchParams.get('member'),'self');assert.equal(rooms.searchParams.get('q'),'100%_ & 봄');assert.equal(rooms.searchParams.has('area'),false);
 assert.match(b.element('#list').innerHTML,/검색 결과가 없어요/);
 await b.element('#clearSearch').handlers.click({});assert.equal(b.run('scopes.monitor.query'),'');assert.equal(new URL(requests.at(-1),'https://example.com').searchParams.has('q'),false);
});

test('관리자 방 목록은 상대 회원과 종료 상태 및 삭제된 검색 원문을 안전하게 표시한다',async()=>{
 const p={id:'self',nick:'봄',year:1995,gender:'여성',area:'서울 동부',memo:'소개'};
 const b=browser({pathname:'/codenotekyh',fetchReply:()=>[{id:'room',firstId:'peer',first:'<img src=x>',firstArea:'경기 남부',firstDeletedAt:123,secondId:'self',second:'봄',secondArea:'서울 동부',closedAt:234,closedReason:'blocked',recent:345,matchingMessages:2,matchSnippet:'<script>별빛</script>',matchDeletedAt:234}]});
 b.run("scopes.monitor.query='별빛'");await b.run('monitorRooms('+JSON.stringify(p)+')');const html=b.element('#list').innerHTML;
 assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/종료된 대화 · 차단/);assert.match(html,/내용 2개 일치/);assert.match(html,/삭제된 채팅/);assert.match(html,/&lt;script&gt;<mark>별빛<\/mark>&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x>/);
});

test('관리자 대화 내용 검색은 이전 검색 결과도 같은 검색어로 요청하고 전체 보기로 해제한다',async()=>{
 const requests=[],items=Array.from({length:60},(_,i)=>({id:i+20,author:'peer',nick:'상대',sent:100,body:'<b>100%_</b>',visibility:'visible',deleted:true,deletedAt:100}));
 const b=browser({pathname:'/codenotekyh',fetchReply:url=>{requests.push(url);return requests.length===1?items:[];}});
 await b.run("conversation('room','대화',true,monitor,null,'',null,'100%_')");
 assert.equal(new URL(requests[0],'https://example.com').searchParams.get('q'),'100%_');assert.match(b.element('#log').innerHTML,/&lt;b&gt;<mark>100%_<\/mark>&lt;\/b&gt;/);
 await b.element('#older').handlers.click({});const older=new URL(requests.at(-1),'https://example.com');assert.equal(older.searchParams.get('q'),'100%_');assert.equal(older.searchParams.get('before'),'20');
 await b.element('#clearSearch').handlers.click({});assert.equal(requests.at(-1),'/api/admin/rooms/room/messages');
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
  assert.match(b.element('dialog1').innerHTML,/양쪽 대화에서 사라져요/);assert.match(b.element('dialog1').innerHTML,/사진과 글은 전송 후 24시간/);assert.doesNotMatch(b.element('dialog1').innerHTML,/관리자|운영자/);
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
  await b.element('#leaveRoom').handlers.click({});assert.match(b.element('dialog1').innerHTML,/나와 상대방의 채팅방이 모두 삭제/);assert.match(b.element('dialog1').innerHTML,/사진과 글은 전송 후 24시간/);
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

test('링크세팅은 인증폼과 두 앱 주소를 함께 저장하며 위험한 URL은 전송하지 않는다',async()=>{
  const writes=[];const b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
    assert.equal(url,'/api/admin/link-settings');
    if(options.method==='GET')return {url:'https://forms.example/request',androidUrl:'https://download.example/android',iosUrl:'https://download.example/ios'};
    const body=JSON.parse(options.body);writes.push(body);return body;
  }});
  await b.run('adminLinkSettings()');const html=b.element('#app').innerHTML;assert.match(html,/id="androidUrl"/);assert.match(html,/id="iosUrl"/);assert.doesNotMatch(html,/<input[^>]*required/);
  const form=b.element('form');form.values={url:'https://forms.example/request',androidUrl:'',iosUrl:'https://download.example/ios'};
  await form.handlers.submit({preventDefault(){},currentTarget:form});assert.deepEqual(writes,[{url:'https://forms.example/request',androidUrl:'',iosUrl:'https://download.example/ios'}]);
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

const announcementFixture={enabled:true,title:'안내 <제목>',body:'첫째 줄\n<img src=x onerror=alert(1)>',androidEnabled:true,iosEnabled:true,androidUrl:'',iosUrl:'https://apps.example/ios'};
const urgentFixture={enabled:true,title:'긴급 <안내>',body:'중요한 첫 줄\n<img src=x onerror=alert(1)>',revision:'urgent-1',publishedAt:Date.UTC(2026,10,27,12)};
const noUrgent={enabled:false,title:'긴급공지',body:'',revision:null,publishedAt:null};
function announcementMember(b){b.run("stage='member';me={id:'notice-member',nick:'공지 회원'};accountState={stage:'member',profile:me,needsRecoveryCopy:false};paint('프로필 목록','book','회원 화면');memberViewReady=true;urgentChecked=true");}
test('로그인 후 웹 공지는 안전한 본문과 하단 앱 버튼을 표시하며 로그인 전 다운로드 버튼도 유지한다',async()=>{
 const opened=[],requests=[];
 const b=browser({pathname:'/',userAgent:'Mozilla/5.0 Macintosh Chrome',windowProps:{open:(...args)=>opened.push(args)},fetchReply:url=>{requests.push(url);return url==='/api/announcement'?announcementFixture:{androidUrl:'',iosUrl:'https://apps.example/ios'};}});
 b.run('gate()');await b.run('maybeAnnouncement()');
 assert.equal(requests.includes('/api/announcement'),false);
 assert.match(b.element('#app').innerHTML,/download-android/);assert.match(b.element('#app').innerHTML,/download-ios/);
 announcementMember(b);await b.run('maybeAnnouncement()');
 const d=b.element('dialog1');assert.equal(d.open,true);assert.match(d.innerHTML,/안내 &lt;제목&gt;/);assert.match(d.innerHTML,/첫째 줄\n&lt;img/);assert.doesNotMatch(d.innerHTML,/<img/);
 assert.ok(d.innerHTML.indexOf('announcement-content')<d.innerHTML.indexOf('announcement-footer'));
 assert.ok(d.innerHTML.indexOf('announcement-android')<d.innerHTML.indexOf('announcement-ios'));
 assert.ok(d.innerHTML.indexOf('announcement-ios')<d.innerHTML.indexOf('announcement-hide'));
 b.element('#announcement-android').onclick();assert.equal(b.element('#announcement-status').textContent,'아직 개발 진행중이에요.');
 b.element('#announcement-ios').onclick();assert.deepEqual(opened,[['https://apps.example/ios','_blank','noopener,noreferrer']]);
 b.element('#announcement-close').onclick();assert.equal(d.open,false);assert.equal(b.local.has('paperchat.announcement.hiddenUntil'),false);
 await b.run('maybeAnnouncement()');assert.equal(requests.filter(v=>v==='/api/announcement').length,1);
});

test('공지에서 앱 버튼을 개별로 숨겨도 로그인 화면 다운로드 버튼은 그대로 남는다',async()=>{
 for(const androidEnabled of [false,true])for(const iosEnabled of [false,true]){
  const data={...announcementFixture,androidEnabled,iosEnabled};
  const b=browser({userAgent:'Mozilla/5.0 Macintosh Chrome',fetchReply:()=>data});b.run('gate()');
  assert.match(b.element('#app').innerHTML,/download-android/);assert.match(b.element('#app').innerHTML,/download-ios/);
  announcementMember(b);await b.run('maybeAnnouncement()');
  const html=b.element('dialog1').innerHTML;
  assert.equal(html.includes('id="announcement-android"'),androidEnabled);assert.equal(html.includes('id="announcement-ios"'),iosEnabled);
  assert.match(html,/4시간 보지않기/);assert.match(html,/id="announcement-close"/);
 }
});

test('4시간 숨김은 브라우저 저장소에 남고 재접속시 유지되며 만료 후 다시 표시한다',async()=>{
 const b=browser({fetchReply:()=>announcementFixture});announcementMember(b);await b.run('maybeAnnouncement()');const before=Date.now();
 b.element('#announcement-hide').onclick();const key='paperchat.announcement.hiddenUntil',until=Number(b.local.get(key));
 assert.ok(until>=before+4*60*60*1000 && until<=Date.now()+4*60*60*1000);assert.equal(b.element('dialog1').open,false);
 const requests=[],again=browser({fetchReply:url=>{requests.push(url);return {...announcementFixture,title:'수정된 공지',body:'수정 후에도 숨김 유지'};}});announcementMember(again);again.local.set(key,String(until));await again.run('maybeAnnouncement()');assert.deepEqual(requests,[]);
 again.local.set(key,String(Date.now()-1));await again.run('maybeAnnouncement()');assert.deepEqual(requests,['/api/announcement']);assert.equal(again.element('dialog1').open,true);
 for(const stored of ['bad',String(Date.now()+10*60*60*1000)]){const broken=browser({fetchReply:()=>announcementFixture});announcementMember(broken);broken.local.set(key,stored);await broken.run('maybeAnnouncement()');assert.equal(broken.element('dialog1').open,true);}
});

test('웹과 네이티브 앱은 같은 공지를 표시하고 앱의 다운로드 버튼만 숨긴다',async()=>{
 for(const input of [{userAgent:'Mozilla/5.0 Macintosh Chrome'},{userAgent:'Mozilla/5.0 Android SamsungBrowser Mobile'},{userAgent:'Mozilla/5.0 iPhone Mobile Safari'}]){
  const b=browser({...input,fetchReply:()=>announcementFixture});announcementMember(b);await b.run('maybeAnnouncement()');assert.equal(b.element('dialog1').open,true);
 }
 for(const input of [{userAgent:'PaperChatAndroid/3'},{userAgent:'PaperChatIOS/4'},{windowProps:{paperChatNativeForeground:true}},{windowProps:{webkit:{messageHandlers:{paperChatPush:{}}}}}]){
  const requests=[],b=browser({...input,fetchReply:url=>{requests.push(url);return announcementFixture;}});announcementMember(b);await b.run('maybeAnnouncement()');assert.deepEqual(requests,['/api/announcement']);assert.equal(b.element('dialog1').open,true);
  assert.doesNotMatch(b.element('dialog1').innerHTML,/announcement-android|announcement-ios/);assert.match(b.element('dialog1').innerHTML,/announcement-hide/);assert.match(b.element('dialog1').innerHTML,/announcement-close/);
 }
 const requests=[],admin=browser({pathname:'/codenotekyh',fetchReply:url=>requests.push(url)});announcementMember(admin);await admin.run('maybeAnnouncement()');assert.deepEqual(requests,[]);
});

test('공지 비활성·조회 실패는 회원 화면을 유지하고 지연 응답은 종료된 로그인 화면을 덮지 않는다',async()=>{
 for(const data of [{...announcementFixture,enabled:false},{$status:503,$body:{error:'offline'}}]){
  const b=browser({fetchReply:()=>data});announcementMember(b);b.element('#memo').value='작성 중';await b.run('maybeAnnouncement()');
  assert.match(b.element('#app').innerHTML,/프로필 목록/);assert.equal(b.element('#memo').value,'작성 중');assert.equal(b.element('dialog1').open,undefined);
 }
 let release;const b=browser({fetchReply:()=>new Promise(r=>release=r)});announcementMember(b);const pending=b.run('maybeAnnouncement()');b.run('clearMemberSession();loginPage()');const html=b.element('#app').innerHTML;release(announcementFixture);await pending;
 assert.equal(b.element('#app').innerHTML,html);assert.equal(b.element('dialog1').open,undefined);
});

test('인증 전·가입 중·제한·규칙 동의·복구코드 미보관 상태에서는 공지를 조회하거나 직접 표시하지 않는다',async()=>{
 for(const state of [{stage:'gate'},{stage:'gate_ok'},{stage:'details'},{stage:'policy',id:'self'},
  {stage:'restricted',id:'self'},{stage:'member'},{stage:'member',id:'self',needsRecoveryCopy:true}]){
  const requests=[],b=browser({fetchReply:url=>{requests.push(url);return announcementFixture;}});
  b.run(`stage=${JSON.stringify(state.stage)};me=${state.id?JSON.stringify({id:state.id}):'null'};accountState=${JSON.stringify(state)}`);
  await b.run('maybeAnnouncement()');b.run(`showAnnouncement(${JSON.stringify(announcementFixture)})`);
  assert.deepEqual(requests,[]);assert.equal(b.element('dialog1').open,undefined);assert.equal(b.run('announcementRequested'),false);
 }
});

test('실제 시작 흐름은 로그인 전 공지를 조회하지 않고 기존 회원 로그인 입력도 그대로 유지한다',async()=>{
 const requests=[],b=browser({pathname:'/',instantSplash:true,userAgent:'Mozilla/5.0 Macintosh Chrome',fetchReply:url=>{
  requests.push(url);return url==='/api/announcement'?announcementFixture:url==='/api/download-links'?{androidUrl:'',iosUrl:''}:{stage:'gate'};
 }});
 await b.run('start()');await settle();
 assert.match(b.element('#app').innerHTML,/인증키를 입력해 주세요/);assert.match(b.element('#app').innerHTML,/download-android/);
 assert.equal(requests.includes('/api/announcement'),false);assert.equal(b.element('dialog1').open,undefined);
 await b.element('#existing').handlers.click({});b.element('#recovery').value='로그인 입력 중';await b.run('maybeAnnouncement()');
 assert.equal(requests.includes('/api/announcement'),false);assert.equal(b.element('#recovery').value,'로그인 입력 중');
});

test('자동 로그인 시작은 프로필 또는 받은 대화 목록을 완성한 뒤에만 공지를 표시한다',async()=>{
 for(const inbox of [false,true]){
  const requests=[];let completeList;
  const endpoint=inbox?'/api/rooms':'/api/people';
  const b=browser({pathname:'/',search:inbox?'?inbox=1':'',instantSplash:true,fetchReply:url=>{
   requests.push(url);
   if(url===endpoint)return new Promise(resolve=>completeList=resolve);
   if(url==='/api/announcement')return announcementFixture;
   if(url==='/api/unread')return {total:0};
   return {stage:'member',profile:{id:'self',nick:'자동 로그인'},needsRecoveryCopy:false};
  }});
  const starting=b.run('start()');await settle();
  assert.equal(typeof completeList,'function');assert.equal(requests.includes('/api/announcement'),false);
  completeList([]);await starting;await settle();
  assert.ok(requests.indexOf(endpoint)<requests.indexOf('/api/announcement'));
  assert.match(b.element('#app').innerHTML,inbox?/내 대화/:/프로필 목록/);assert.equal(b.element('dialog1').open,true);
 }
});

test('기존 회원 로그인이 성공하고 프로필 목록을 연 뒤 공지를 한 번 표시하며 로그인 실패 때는 조회하지 않는다',async()=>{
 const requests=[];let accepted=false,completeList;
 const b=browser({pathname:'/',fetchReply:url=>{
  requests.push(url);
  if(url==='/api/account/login')return accepted?{}:{$status:403,$body:{error:'복구코드를 확인해 주세요.'}};
  if(url==='/api/state')return {stage:'member',profile:{id:'self',nick:'로그인 성공'},needsRecoveryCopy:false};
  if(url==='/api/people')return new Promise(resolve=>completeList=resolve);
  if(url==='/api/unread')return {total:0};
  if(url==='/api/announcement')return announcementFixture;
  return {};
 }});
 b.run("stage='gate';loginPage()");await submitForm(b,{recovery:'잘못된 코드'});
 assert.equal(requests.includes('/api/announcement'),false);assert.match(b.element('#error').textContent,/복구코드/);
 accepted=true;const signingIn=submitForm(b,{recovery:'올바른 코드'});await settle();
 assert.equal(typeof completeList,'function');assert.equal(requests.includes('/api/announcement'),false);
 completeList([]);await signingIn;await settle();assert.equal(b.element('dialog1').open,true);
 b.element('#announcement-close').onclick();await b.run('maybeAnnouncement()');
 assert.equal(requests.filter(url=>url==='/api/announcement').length,1);
});

test('신규 가입은 복구코드 보관을 먼저 완료하고 이후 프로필 화면에서 공지를 표시한다',async()=>{
 const requests=[];let needsRecoveryCopy=true;
 const b=browser({fetchReply:(url,options)=>{
  requests.push(url+(options.method==='POST'?' POST':''));
  if(url==='/api/state')return {stage:'member',profile:{id:'new-member',nick:'신규 회원'},needsRecoveryCopy};
  if(url==='/api/account/recovery'){
   if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{saved:true});needsRecoveryCopy=false;return {};}
   return {code:'PERSONAL-RECOVERY-CODE'};
  }
  if(url==='/api/people')return [];
  if(url==='/api/unread')return {total:0};
  if(url==='/api/announcement')return announcementFixture;
  return {};
 }});
 b.run("stage='details';draft.province='서울';draft.district='동부';memo()");
 await submitForm(b,{memo:'새 소개글'});await settle();
 assert.ok(requests.includes('/api/register POST'));assert.match(b.element('#app').innerHTML,/개인 복구코드/);
 assert.equal(requests.includes('/api/announcement'),false);assert.equal(b.element('dialog1').open,undefined);
 await submitForm(b,{});await settle();
 assert.match(b.element('#app').innerHTML,/프로필 목록/);assert.equal(b.element('dialog1').open,true);
 assert.ok(requests.indexOf('/api/account/recovery POST')<requests.indexOf('/api/people'));
 assert.ok(requests.indexOf('/api/people')<requests.indexOf('/api/announcement'));
});

test('실제 로그아웃 후 늦게 도착한 공지 응답은 이동 전 화면에 표시하지 않는다',async()=>{
 let release;const b=browser({pathname:'/',fetchReply:url=>url==='/api/announcement'?new Promise(resolve=>release=resolve):{}});
 announcementMember(b);b.run('settings()');const pending=b.run('maybeAnnouncement()');
 await b.element('#logout').handlers.click({});assert.equal(b.location.redirect,'/');
 release(announcementFixture);await pending;
 assert.equal(b.element('dialog1').open,undefined);
});

test('회원 세션을 비운 뒤 다음 로그인은 새 공지를 요청하고 이전 세션의 지연 응답은 무시한다',async()=>{
 let release,count=0;const b=browser({fetchReply:()=>++count===1?new Promise(resolve=>release=resolve):announcementFixture});
 announcementMember(b);const previous=b.run('maybeAnnouncement()');b.run('clearMemberSession()');
 assert.equal(b.run('announcementRequested'),false);
 announcementMember(b);b.run("me.id='next-member'");await b.run('maybeAnnouncement()');
 assert.equal(count,2);assert.equal(b.element('dialog1').open,true);
 release({...announcementFixture,title:'이전 세션 공지'});await previous;
 assert.doesNotMatch(b.element('dialog1').innerHTML,/이전 세션 공지/);assert.equal(b.element('dialog2').open,undefined);
});

test('관리자는 공지와 두 버튼 표시 여부 및 공유 다운로드 주소를 함께 저장한다',async()=>{
 const writes=[],b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
  assert.equal(url,'/api/admin/announcement');if(options.method==='GET')return announcementFixture;
  const value=JSON.parse(options.body);writes.push(value);return value;
 }});
 await b.run('adminAnnouncement()');const html=b.element('#app').innerHTML;assert.match(html,/공지 안의 버튼에만/);assert.match(html,/name="androidEnabled"/);assert.match(html,/name="iosEnabled"/);
 const form=b.element('form');form.values={enabled:'on',title:' 알림 ',body:' 안내 내용 ',androidEnabled:'',iosEnabled:'on',androidUrl:'',iosUrl:'https://apps.example/new'};
 await form.handlers.submit({preventDefault(){},currentTarget:form});assert.deepEqual(writes,[{enabled:true,title:'알림',body:'안내 내용',androidEnabled:false,iosEnabled:true,androidUrl:'',iosUrl:'https://apps.example/new'}]);
 form.values.title=' ';await form.handlers.submit({preventDefault(){},currentTarget:form});assert.equal(writes.length,1);assert.match(b.element('#error').textContent,/제목과 내용/);
 form.values={enabled:'',title:'',body:'',androidEnabled:'',iosEnabled:'',androidUrl:'',iosUrl:''};await form.handlers.submit({preventDefault(){},currentTarget:form});assert.equal(writes.length,2);assert.equal(writes[1].enabled,false);
});

test('로그인 완료 후 긴급공지를 먼저 확인하고 닫은 뒤에만 일반 공지를 조회한다',async()=>{
 const calls=[];let releaseUrgent;
 const b=browser({pathname:'/',instantSplash:true,urgentReply:(url,options)=>{
  calls.push(url);assert.equal(options.headers['X-PaperChat-Member'],'self');return new Promise(resolve=>releaseUrgent=resolve);
 },fetchReply:url=>{
  calls.push(url);if(url==='/api/people')return [];if(url==='/api/unread')return {total:0};if(url==='/api/announcement')return announcementFixture;
  return {stage:'member',profile:{id:'self',nick:'회원'},needsRecoveryCopy:false};
 }});
 await b.run('start()');await settle();
 assert.match(b.element('#app').innerHTML,/프로필 목록/);assert.ok(calls.indexOf('/api/people')<calls.indexOf('/api/urgent-announcement'));
 assert.equal(calls.includes('/api/announcement'),false);
 releaseUrgent(urgentFixture);await b.run('urgentSync');
 const urgent=b.run('urgentDialog');assert.equal(urgent.open,true);assert.equal(urgent.parentElement,b.element('body'));
 assert.equal(calls.includes('/api/announcement'),false);
 urgent.querySelector('#urgent-close').onclick();await settle();
 assert.equal(urgent.open,false);assert.equal(b.element('dialog2').open,true);assert.match(b.element('dialog2').innerHTML,/announcement-heading/);
 assert.equal(calls.filter(url=>url==='/api/announcement').length,1);
});

test('긴급공지는 웹·설치앱 모두 4시간 숨김을 무시하고 닫기만 제공하며 Esc·네이티브 뒤로가기로 종료되지 않는다',async()=>{
 for(const userAgent of ['Mozilla/5.0 Macintosh Chrome','Mobile PaperChatAndroid/3','Mobile PaperChatIOS/4']){
  const calls=[],b=browser({userAgent,urgentReply:urgentFixture,fetchReply:url=>{calls.push(url);return announcementFixture;}});
  announcementMember(b);const until=String(Date.now()+4*60*60*1000);b.local.set('paperchat.announcement.hiddenUntil',until);
  await b.run('syncUrgentAnnouncement(true)');const d=b.run('urgentDialog');
  assert.equal(d.open,true);assert.equal(d.attributes['aria-modal'],'true');assert.match(d.innerHTML,/긴급 &lt;안내&gt;/);assert.match(d.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(d.innerHTML,/<img|4시간|announcement-hide|announcement-android|announcement-ios/);assert.equal((d.innerHTML.match(/<button\b/g)||[]).length,1);
  let cancelled=false;d.handlers.cancel({preventDefault(){cancelled=true;}});assert.equal(cancelled,true);assert.equal(d.open,true);
  assert.equal(b.run('window.paperChatBack()'),true);assert.equal(d.open,true);assert.equal(b.run('urgentSeenRevision'),null);
  d.querySelector('#urgent-close').onclick();await settle();assert.equal(d.open,false);assert.equal(b.run('urgentSeenRevision'),'urgent-1');
  assert.equal(b.local.get('paperchat.announcement.hiddenUntil'),until);assert.equal(calls.includes('/api/announcement'),false);
 }
});

test('긴급공지 revision은 열린 화면과 닫은 공지의 중복을 막고 같은 내용의 재게시를 다시 표시한다',async()=>{
 let data={...urgentFixture};const b=browser({urgentReply:()=>data,fetchReply:()=>({...announcementFixture,enabled:false})});
 announcementMember(b);await b.run('syncUrgentAnnouncement(true)');const first=b.run('urgentDialog');
 await b.run('syncUrgentAnnouncement(true)');assert.equal(b.run('urgentDialog'),first);assert.equal(b.element('dialog2').open,undefined);
 first.querySelector('#urgent-close').onclick();await settle();await b.run('syncUrgentAnnouncement(true)');assert.equal(b.run('urgentDialog'),null);
 data={...urgentFixture,revision:'urgent-2',publishedAt:urgentFixture.publishedAt+1};await b.run('syncUrgentAnnouncement(true)');
 const second=b.run('urgentDialog');assert.notEqual(second,first);assert.equal(second.open,true);assert.equal(second.dataset.revision,'urgent-2');
});

test('긴급공지는 일반 모달과 작성 중 입력을 유지하고 앱 화면이 다시 그려져도 body에서 열린 상태를 유지한다',async()=>{
 const b=browser({urgentReply:urgentFixture,fetchReply:()=>({...announcementFixture,enabled:false})});announcementMember(b);
 b.run('privacyPage()');const ordinary=b.element('dialog1');b.element('#body').value='작성 중인 글';b.element('#body').selectionStart=2;b.element('#body').selectionEnd=4;
 const before=b.element('#app').innerHTML,view=b.run('epoch');await b.run('syncUrgentAnnouncement(true)');const urgent=b.run('urgentDialog');
 assert.equal(ordinary.open,true);assert.equal(urgent.open,true);assert.equal(b.element('#app').innerHTML,before);assert.equal(b.run('epoch'),view);
 assert.equal(b.element('#body').value,'작성 중인 글');assert.equal(b.element('#body').selectionStart,2);assert.equal(b.element('#body').selectionEnd,4);
 b.run("paint('다른 회원 화면','book','바뀐 내용')");assert.equal(ordinary.open,false);assert.equal(urgent.open,true);assert.equal(urgent.parentElement,b.element('body'));
 assert.match(b.element('#app').innerHTML,/바뀐 내용/);urgent.querySelector('#urgent-close').onclick();await settle();
 assert.equal(urgent.open,false);assert.match(b.element('#app').innerHTML,/바뀐 내용/);
});

test('접속 중 긴급공지 SSE와 재연결은 최신 공지를 확인하고 이전 연결의 이벤트를 무시한다',async()=>{
 const {sources,EventSource}=eventStreams();let data=noUrgent,requests=0;
 const b=browser({EventSource,urgentReply:()=>{requests++;return data;},fetchReply:()=>({stage:'member',memberId:'notice-member',total:0})});announcementMember(b);
 b.local.set('paperchat.announcement.hiddenUntil',String(Date.now()+60000));b.run('updatePresence()');await settle();
 data=urgentFixture;sources[0].emit('urgent-announcement',{revision:'urgent-1'});await settle();assert.equal(b.run('urgentDialog.open'),true);assert.equal(requests,1);
 b.run('urgentDialog').querySelector('#urgent-close').onclick();sources[0].emit('urgent-announcement',{revision:'urgent-1'});await settle();assert.equal(b.run('urgentDialog'),null);
 b.run('window.paperChatPresence(false)');assert.equal(sources[0].closed,true);const oldCount=requests;
 data={...urgentFixture,revision:'urgent-2'};sources[0].emit('urgent-announcement',{revision:'urgent-2'});await settle();assert.equal(requests,oldCount);
 b.run('window.paperChatPresence(true)');await settle();assert.equal(sources.length,2);assert.equal(b.run('urgentDialog.dataset.revision'),'urgent-2');
 b.run('urgentDialog').querySelector('#urgent-close').onclick();data={...urgentFixture,revision:'urgent-3'};
 sources[1].emit('open');await settle();assert.equal(b.run('urgentDialog.dataset.revision'),'urgent-3');
});

test('긴급공지 조회 중 중복 실시간 신호는 마지막 상태를 다시 확인하며 이후 비활성화는 열린 공지를 닫는다',async()=>{
 const replies=[];let calls=0;const b=browser({urgentReply:()=>{calls++;return new Promise(resolve=>replies.push(resolve));},fetchReply:()=>({...announcementFixture,enabled:false})});announcementMember(b);
 const first=b.run('syncUrgentAnnouncement(true)');b.run('syncUrgentAnnouncement(true)');b.run('syncUrgentAnnouncement(true)');assert.equal(calls,1);
 replies.shift()(urgentFixture);await settle();assert.equal(calls,2);assert.equal(b.run('urgentDialog.dataset.revision'),'urgent-1');
 replies.shift()({...urgentFixture,revision:'urgent-2'});await first;assert.equal(b.run('urgentDialog.dataset.revision'),'urgent-2');assert.equal(calls,2);
 const open=b.run('urgentDialog'),stopping=b.run('syncUrgentAnnouncement(true)');replies.shift()({...noUrgent,revision:'disabled-3'});await stopping;
 assert.equal(open.open,false);assert.equal(b.run('urgentDialog'),null);assert.equal(b.run('urgentData.enabled'),false);
});

test('먼저 요청한 일반 공지가 늦게 도착해도 긴급공지를 덮지 않고 닫은 후 일반 공지를 다시 확인한다',async()=>{
 let releaseNormal,normalCalls=0;const b=browser({urgentReply:urgentFixture,fetchReply:()=>++normalCalls===1?new Promise(resolve=>releaseNormal=resolve):announcementFixture});
 announcementMember(b);const normal=b.run('maybeAnnouncement()');await b.run('syncUrgentAnnouncement(true)');const urgent=b.run('urgentDialog');
 releaseNormal(announcementFixture);await normal;
 assert.equal(urgent.open,true);assert.equal(b.element('dialog2').open,undefined);assert.equal(b.run('announcementRequested'),false);
 urgent.querySelector('#urgent-close').onclick();await settle();assert.equal(normalCalls,2);assert.equal(b.element('dialog2').open,true);
 assert.match(b.element('dialog2').innerHTML,/announcement-heading/);assert.equal(b.run('urgentDialog'),null);
});

test('로그아웃 뒤 도착한 긴급공지는 표시하지 않고 다음 계정의 새 요청만 반영한다',async()=>{
 let release,calls=0;const b=browser({pathname:'/',urgentReply:()=>++calls===1?new Promise(resolve=>release=resolve):{...urgentFixture,title:'다음 계정 긴급공지',revision:'urgent-next'},fetchReply:url=>url==='/api/announcement'?{...announcementFixture,enabled:false}:{}});
 announcementMember(b);b.run('settings()');const old=b.run('syncUrgentAnnouncement(true)');await b.element('#logout').handlers.click({});
 assert.equal(b.location.redirect,'/');assert.equal(b.run('urgentData'),null);assert.equal(b.run('urgentChecked'),false);
 announcementMember(b);b.run("me.id='next-member'");b.run('syncUrgentAnnouncement(true)');
 release({...urgentFixture,title:'이전 계정 긴급공지'});await old;await settle();
 assert.equal(calls,2);assert.equal(b.run('urgentDialog.open'),true);assert.match(b.run('urgentDialog.innerHTML'),/다음 계정 긴급공지/);assert.doesNotMatch(b.run('urgentDialog.innerHTML'),/이전 계정/);
});

test('긴급공지 조회 실패·잘못된 응답은 회원 화면과 입력을 유지하고 다음 정상 확인에서 회복한다',async()=>{
 for(const failed of [{$status:503,$body:{error:'offline'}},{enabled:true,title:'잘못된 응답',body:'revision 없음'}]){
  let data=failed;const b=browser({urgentReply:()=>data,fetchReply:()=>announcementFixture});announcementMember(b);b.run('urgentChecked=false');b.element('#body').value='계속 작성 중';const html=b.element('#app').innerHTML;
  await b.run('syncUrgentAnnouncement(true)');assert.equal(b.run('urgentDialog'),null);assert.equal(b.run('urgentChecked'),false);assert.equal(b.run('nextUrgentSync'),0);
  assert.equal(b.element('#app').innerHTML,html);assert.equal(b.element('#body').value,'계속 작성 중');
  data=noUrgent;await b.run('syncUrgentAnnouncement(true)');await settle();assert.equal(b.run('urgentChecked'),true);assert.equal(b.element('dialog1').open,true);
 }
});

test('긴급공지는 회원 화면 준비 전과 제한·관리자·백그라운드에서 조회하지 않으며 복구코드 화면에서는 우선 표시한다',async()=>{
 for(const setup of ["stage='gate'","stage='details'","stage='restricted'","stage='policy'","memberViewReady=false","nativeForeground=false"]){
  let calls=0;const b=browser({urgentReply:()=>{calls++;return urgentFixture;},fetchReply:()=>({})});announcementMember(b);b.run(setup);await b.run('syncUrgentAnnouncement(true)');assert.equal(calls,0);assert.equal(b.run('urgentDialog'),null);
 }
 let adminCalls=0;const admin=browser({pathname:'/codenotekyh',urgentReply:()=>{adminCalls++;return urgentFixture;},fetchReply:()=>({})});announcementMember(admin);await admin.run('syncUrgentAnnouncement(true)');assert.equal(adminCalls,0);
 const b=browser({urgentReply:urgentFixture,fetchReply:()=>({code:'RECOVERY'})});announcementMember(b);b.run('accountState.needsRecoveryCopy=true');await b.run('recoveryPage()');await b.run('syncUrgentAnnouncement(true)');
 assert.match(b.element('#app').innerHTML,/개인 복구코드/);assert.equal(b.run('urgentDialog.open'),true);
 b.run('urgentDialog').querySelector('#urgent-close').onclick();await settle();assert.equal(b.element('dialog2').open,undefined);
});

test('보호 화면으로 잠시 닫힌 긴급공지는 확인 처리하지 않고 앱 복귀 때 다시 표시한다',async()=>{
 const b=browser({urgentReply:urgentFixture,fetchReply:()=>({...announcementFixture,enabled:false})});announcementMember(b);await b.run('syncUrgentAnnouncement(true)');const first=b.run('urgentDialog');
 b.run('veil(true)');assert.equal(first.open,false);assert.equal(b.run('urgentSeenRevision'),null);
 b.run('veil(false)');await b.run('syncUrgentAnnouncement(true)');assert.equal(b.run('urgentDialog.open'),true);assert.notEqual(b.run('urgentDialog'),first);
});

test('긴급공지와 일반 모달 뒤에 도착한 메시지는 읽지 않고 닫은 뒤 읽음을 재개한다',async()=>{
 for(const kind of ['urgent','privacy']){
  const reads=[];let messages=[{id:1,author:'peer',nick:'상대',body:'이미 본 메시지',sent:1,visibility:'visible'}];
  const b=browser({urgentReply:urgentFixture,fetchReply:(url,options)=>{
   if(url.endsWith('/messages'))return messages;
   if(url.endsWith('/read'))reads.push(JSON.parse(options.body).through);
   if(url==='/api/announcement')return {...announcementFixture,enabled:false};
   return {total:0};
  }});
  announcementMember(b);await b.run("conversation('room','상대',false,rooms,'peer')");assert.deepEqual(reads,[1]);
  const input=b.element('#body');input.value='보내지 않은 초안';input.selectionStart=2;input.selectionEnd=5;
  if(kind==='urgent')await b.run('syncUrgentAnnouncement(true)');else b.run('privacyPage()');
  const dialog=b.run("document.querySelector('dialog[open]')");assert.equal(dialog.open,true);
  messages=[...messages,{id:2,author:'peer',nick:'상대',body:'모달 뒤에 도착한 메시지',sent:2,visibility:'visible'}];
  const polling=[...b.intervals.values()].find(timer=>timer.ms===2500);assert.ok(polling);
  polling.fn();await settle();b.element('#log').handlers.scroll();b.run('chatLayout.resize()');await settle();
  assert.equal(dialog.open,true);assert.deepEqual(reads,[1]);
  assert.match(b.element('#log').innerHTML,/모달 뒤에 도착한 메시지/);
  dialog.querySelector(kind==='urgent'?'#urgent-close':'#privacy-close').onclick();await settle();
  assert.equal(dialog.open,false);polling.fn();await settle();assert.deepEqual(reads,[1,2]);
  assert.equal(input.value,'보내지 않은 초안');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);
 }
});

test('긴급공지를 읽는 중 제한 또는 약관 동의 상태가 되면 공지를 닫고 해당 계정 화면으로 전환한다',async()=>{
 for(const stage of ['restricted','policy']){
  let urgentCalls=0;
  const state={stage,memberId:'notice-member',profile:null,restrictedUntil:Date.now()+3600000};
  const b=browser({urgentReply:()=>{urgentCalls++;return urgentFixture;},fetchReply:url=>
   url==='/api/state'||url==='/api/status?member=1'?state:{total:0}});
  announcementMember(b);await b.run('syncUrgentAnnouncement(true)');const dialog=b.run('urgentDialog');
  assert.equal(dialog.open,true);assert.equal(urgentCalls,1);
  // Use the ordinary background status check, without veil() closing the modal first.
  await b.run('pulse()');
  assert.equal(b.run('stage'),stage);assert.equal(dialog.open,false);assert.equal(b.run('urgentDialog'),null);
  assert.equal(b.run('urgentSeenRevision'),null);assert.equal(dialog.parentElement,null);
  assert.match(b.element('#app').innerHTML,stage==='restricted'?/계정 이용 제한/:/이용규칙 확인/);
  await b.run('syncUrgentAnnouncement(true)');assert.equal(urgentCalls,1);
 }
});

test('관리자 긴급공지 폼은 게시 필수값을 검사하고 저장·게시중단 값을 정확히 보낸다',async()=>{
 const writes=[],b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{
  assert.equal(url,'/api/admin/urgent-announcement');if(options.method==='GET')return urgentFixture;
  const value=JSON.parse(options.body);writes.push(value);return {...value,revision:'saved-'+writes.length,publishedAt:value.enabled?urgentFixture.publishedAt:null};
 }});
 await b.run('adminUrgentAnnouncement()');const html=b.element('#app').innerHTML;assert.match(html,/id="urgentEnabled"/);assert.match(html,/4시간 숨김은 적용되지/);assert.match(html,/같은 내용이라도 다시 게시/);assert.match(html,/긴급 &lt;안내&gt;/);
 await submitForm(b,{enabled:'on',title:' ',body:'내용'});assert.equal(writes.length,0);assert.match(b.element('#error').textContent,/제목과 내용/);
 await submitForm(b,{enabled:'on',title:' 긴급 안내 ',body:' 첫 줄\n둘째 줄 '});assert.deepEqual(writes,[{enabled:true,title:'긴급 안내',body:'첫 줄\n둘째 줄'}]);
 assert.equal(b.element('#urgentTitle').value,'긴급 안내');assert.match(b.element('#urgentPublished').textContent,/마지막 게시/);
 await submitForm(b,{enabled:'',title:'',body:''});assert.deepEqual(writes[1],{enabled:false,title:'',body:''});assert.match(b.element('#urgentPublished').textContent,/게시가 중단/);
});

test('키보드 애니메이션 동안 하단을 유지하고 과거 대화 스크롤과 초안은 보존한다',()=>{
 const frames=new Map();let seq=0;const b=browser({windowProps:{requestAnimationFrame:fn=>{frames.set(++seq,fn);return seq;},cancelAnimationFrame:id=>frames.delete(id)},fetchReply:()=>({})});
 const flush=()=>{const jobs=[...frames.values()];frames.clear();for(const fn of jobs)fn();};
 const log=b.element('#log'),composer=b.element('#body');log.scrollHeight=2000;log.clientHeight=600;log.scrollTop=1400;composer.value='아직 작성 중';composer.selectionStart=3;composer.selectionEnd=5;
 b.run('var visible=0;var layout=followChatLayout($("#log"),$("#body"),()=>true,()=>visible++)');
 for(const height of [500,400,300]){log.clientHeight=height;b.run('layout.resize()');log.handlers.scroll();flush();assert.equal(log.scrollTop,2000);}
 log.scrollTop=350;log.handlers.wheel({deltaY:-10});log.handlers.scroll();log.clientHeight=250;b.run('layout.resize()');flush();assert.equal(log.scrollTop,350);
 log.scrollHeight=2200;log.handlers.load();flush();assert.equal(log.scrollTop,350);
 composer.handlers.focus();flush();assert.equal(log.scrollTop,2200);
 assert.equal(composer.value,'아직 작성 중');assert.equal(composer.selectionStart,3);assert.equal(composer.selectionEnd,5);
 log.scrollHeight=2500;log.handlers.load();flush();assert.equal(log.scrollTop,2500);
 b.run('layout.resize();layout.dispose()');assert.equal(frames.size,0);
});

test('예약된 키보드 스크롤은 방 이동 후 적용되지 않고 사용자 스크롤이 우선한다',()=>{
 const frames=[];const b=browser({windowProps:{requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}},fetchReply:()=>({})});const log=b.element('#log');
 log.scrollHeight=1000;log.clientHeight=300;log.scrollTop=700;
 b.run('var sameRoom=true;var layout=followChatLayout($("#log"),null,()=>sameRoom,()=>{})');b.run('layout.resize()');b.run('sameRoom=false');log.scrollTop=50;frames.shift()();assert.equal(log.scrollTop,50);
 b.run('sameRoom=true;layout.bottom()');log.handlers.touchmove({});log.scrollTop=80;frames.shift()();assert.equal(log.scrollTop,80);
});

test('키보드로 목록 높이가 0이면 읽음 처리하지 않는다',async()=>{
 const requests=[],b=browser({fetchReply:url=>{requests.push(url);if(url.endsWith('/messages'))return [{id:1,author:'b',body:'안 보이는 메시지',sent:1,visibility:'visible'}];return {total:0};}});
 b.run("stage='member';me={id:'a'}");b.element('#log').clientHeight=0;
 await b.run("conversation('r','상대',false,rooms,'b')");assert.equal(requests.some(u=>u.endsWith('/read')),false);
});

test('채팅방 상대 프로필은 최신 공개 정보를 모달로 보여주고 입력 초안을 유지한다',async()=>{
 const requests=[],b=browser({fetchReply:url=>{requests.push(url);if(url==='/api/people/b')return {id:'b',nick:'상대 <닉네임>',year:1995,gender:'여성',area:'서울 동부',memo:'변경한 소개글 <script>',online:true};if(url.endsWith('/messages'))return [];return {total:0};}});
 b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");b.element('#body').value='작성중인 대화';const html=b.element('#log').innerHTML;
 await b.element('#peerProfile').handlers.click({});assert.ok(requests.includes('/api/people/b'));
 const d=b.element('dialog1');assert.equal(d.open,true);assert.match(d.innerHTML,/서울 동부/);assert.match(d.innerHTML,/변경한 소개글 &lt;script&gt;/);assert.match(d.innerHTML,/1995년생/);assert.equal(b.element('#body').value,'작성중인 대화');assert.equal(b.element('#log').innerHTML,html);
 b.element('#chat-profile-close').onclick();assert.equal(d.open,false);assert.equal(b.element('#body').value,'작성중인 대화');
});

test('다른 화면으로 이동한 뒤 도착한 상대 프로필 응답은 표시하지 않는다',async()=>{
 let release;const b=browser({fetchReply:url=>url==='/api/people/b'?new Promise(r=>release=r):url.endsWith('/messages')?[]:{total:0}});
 b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");const pending=b.element('#peerProfile').handlers.click({});b.run('settings()');release({id:'b',nick:'이전 상대',memo:'이전 정보'});await pending;assert.equal(b.element('dialog1').open,undefined);assert.match(b.element('#app').innerHTML,/내 설정/);
});

test('웹 채팅 Enter는 기존 form 전송을 사용하고 Shift+Enter·IME 확정은 줄바꿈/조합에 맡긴다',()=>{
 const b=browser({pathname:'/',fetchReply:()=>({})}),input=b.element('#body'),button={disabled:false};let submits=0,prevented=0;
 input.value='안녕하세요';input.form={querySelector:()=>button,requestSubmit:s=>{assert.equal(s,button);submits++;}};b.run('wireChatEnter($("#body"))');
 const event=extra=>({key:'Enter',preventDefault(){prevented++;},...extra});
 input.handlers.keydown(event());assert.equal(submits,1);assert.equal(prevented,1);
 for(const extra of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},{keyCode:229},{key:'a'}])input.handlers.keydown(event(extra));
 input.handlers.compositionstart();input.handlers.keydown(event());assert.equal(submits,1);assert.equal(prevented,1);
 input.handlers.compositionend();input.handlers.keydown(event());assert.equal(submits,2);
 button.disabled=true;input.handlers.keydown(event());assert.equal(submits,2);button.disabled=false;
 input.handlers.keydown(event({repeat:true}));input.value=' \n ';input.handlers.keydown(event());assert.equal(submits,2);
});

test('설치 앱에서는 Enter 키의 기존 줄바꿈 동작을 유지한다',()=>{
 for(const userAgent of ['PaperChatIOS/4','PaperChatAndroid/3']){const b=browser({userAgent,fetchReply:()=>({})});b.run('wireChatEnter($("#body"))');assert.equal(b.element('#body').handlers.keydown,undefined);}
});

test('전송 응답을 기다리며 새로 작성한 문장은 이전 전송 완료가 지우지 않는다',async()=>{
 let release;const sent=[],b=browser({fetchReply:(url,options)=>{
  if(url.endsWith('/messages')&&options.method==='POST'){sent.push(JSON.parse(options.body));return new Promise(r=>release=r);}
  return url.endsWith('/messages')?[]:{total:0};
 }});b.run("stage='member';me={id:'a'}");await b.run("conversation('r','상대',false,rooms,'b')");
 const form=b.element('form'),input=b.element('#body');form.values={body:'첫 번째 메시지'};input.value='첫 번째 메시지';
 const pending=form.handlers.submit({preventDefault(){},currentTarget:form});await new Promise(setImmediate);input.value='이어서 쓰는 다음 메시지';release({});await pending;
 assert.deepEqual(sent,[{body:'첫 번째 메시지'}]);assert.equal(input.value,'이어서 쓰는 다음 메시지');
});


test('검색 강조는 Unicode 소문자 확장·이모지·HTML 원문을 안전하게 유지한다',()=>{
 const b=browser({fetchReply:()=>({})});
 assert.equal(b.run("highlighted('İİİ찾을내용','찾을내용')"),'İİİ<mark>찾을내용</mark>');
 assert.equal(b.run("highlighted('😀İABC <b>abc</b>','abc')"),'😀İ<mark>ABC</mark> &lt;b&gt;<mark>abc</mark>&lt;/b&gt;');
});

test('회원 메시지에는 개별 신고 버튼이 없고 채팅 상단 프로필 오른쪽에 신고하기를 둔다',async()=>{
 const b=browser({fetchReply:()=>[]});b.run("stage='member';me={id:'me'}");
 await b.run("conversation('room','상대',false,rooms,'peer')");
 assert.match(b.element('.hero').innerHTML,/id="peerProfile"[\s\S]*id="reportConversation"/);
 for(const expires of [null,Date.now()+99999]){
  const html=b.run('message('+JSON.stringify({id:1,author:'peer',nick:'상대',body:'안녕',sent:100,visibility:'visible',viewable:1,expires})+',false)');assert.doesNotMatch(html,/data-report|>신고</);
 }
});

test('대화 신고는 사진 묶음 대상 방과 사유를 보내며 작성 중인 초안을 유지한다',async()=>{
 const requests=[];let refreshes=0;
 const b=browser({fetchReply:(url,opts)=>{requests.push([url,JSON.parse(opts.body)]);return {};}});b.run("stage='member';me={id:'me'};paint('대화','chat','작성중화면');conversationReport('room',async()=>{})");b.element('#body').value='전송하지 않은 초안';
 const f=b.element('#conversationReportForm');f.values={reason:'괴롭힘·기타 위반'};
 await f.handlers.submit({preventDefault(){}});
 assert.deepEqual(requests,[['/api/report',{kind:'conversation',room:'room',reason:'괴롭힘·기타 위반'}]]);assert.equal(b.element('dialog1').open,false);assert.equal(b.element('#body').value,'전송하지 않은 초안');assert.match(b.element('#app').innerHTML,/작성중화면/);
});

test('대화 신고 중 중복 전송을 막고 실패하면 신고 사유와 초안을 유지한다',async()=>{
 let release,count=0;const b=browser({fetchReply:()=>{count++;return new Promise(r=>release=r);}});b.run("stage='member';me={id:'me'};conversationReport('room',async()=>{})");b.element('#body').value='초안';const f=b.element('#conversationReportForm');f.values={reason:'괴롭힘·기타 위반'};
 const pending=f.handlers.submit({preventDefault(){}});await f.handlers.submit({preventDefault(){}});assert.equal(count,1);release({$status:400,$body:{error:'잠시 후 다시 신고해 주세요.'}});await pending;
 assert.equal(b.element('dialog1').open,true);assert.equal(f.values.reason,'괴롭힘·기타 위반');assert.equal(b.element('#body').value,'초안');assert.match(b.element('#conversationReportError').textContent,/다시 신고/);assert.equal(b.element('[type=submit]').disabled,false);
});

test('관리자 대화 신고는 묶음 사진과 원래 대화 열람을 함께 제공한다',()=>{
 const b=browser({pathname:'/codenotekyh',fetchReply:()=>({})});
 b.run('reviewItem('+JSON.stringify({id:4,nick:'신고된 회원',area:'서울 동부',sender:'peer',reporter:'me',reason:'괴롭힘·기타 위반',conversationRoom:'room',photoCount:2,photos:[{id:10,viewable:1,expires:Date.now()+99999},{id:11,viewable:0,expires:1}],excerpt:'검토할 대화'})+',false)');
 assert.match(b.element('#app').innerHTML,/대화 신고 검토/);assert.match(b.element('#app').innerHTML,/신고 사진 2장 확인/);assert.match(b.element('#app').innerHTML,/신고된 대화 보기/);
 b.element('#showPhotos').handlers.click({});assert.match(b.element('#preview').innerHTML,/\/api\/admin\/photos\/10/);assert.doesNotMatch(b.element('#preview').innerHTML,/\/api\/admin\/photos\/11/);assert.match(b.element('#preview').innerHTML,/사진이 만료되었거나 삭제/);
});


test('가입자 현황 전체·지역 선택은 상세 및 페이지 이동에도 유지되고 필터 변경은 첫 페이지로 간다',async()=>{
 const requests=[],page={items:[{id:'p',nick:'지역회원',area:'서울 동부',status:'active'}],more:true,counts:{active:51,inactive:1,withdrawn:0}};
 const b=browser({pathname:'/codenotekyh',fetchReply:url=>{requests.push(url);if(url==='/api/regions')return {'서울':['동부','서부'],'경기':['남부','북부']};if(url==='/api/admin/members/p')return {id:'p',nick:'지역회원',status:'active',area:'서울 동부'};return page;}});
 await b.run('membersPage()');assert.equal(requests.at(-1),'/api/admin/members?offset=0');assert.match(b.element('#app').innerHTML,/aria-pressed="true">전체/);
 await b.element('#scope-area').handlers.click({});assert.equal(new URL(requests.at(-1),'https://example.com').searchParams.get('area'),'서울 동부');assert.match(b.element('#app').innerHTML,/지역 정보가 남지 않아/);
 await b.element('#nextPage').handlers.click({});const next=new URL(requests.at(-1),'https://example.com');assert.equal(next.searchParams.get('offset'),'50');assert.equal(next.searchParams.get('area'),'서울 동부');
 await b.run("memberDetail('p',()=>membersPage(50))");await b.element('#back').handlers.click({});assert.equal(new URL(requests.at(-1),'https://example.com').searchParams.get('area'),'서울 동부');
 await b.element('#scope-all').handlers.click({});assert.equal(requests.at(-1),'/api/admin/members?offset=0');
 b.run("scopes.members={regional:true,area:'서울 서부'}");await b.run("membersPage(0,null,'inactive')");assert.equal(new URL(requests.at(-1),'https://example.com').searchParams.get('area'),'서울 서부');assert.equal(new URL(requests.at(-1),'https://example.com').searchParams.get('filter'),'inactive');
});

test('가입자 지역 조회의 늦은 응답은 나중에 선택한 지역을 덮지 않는다',async()=>{
 const resolvers=[],page={items:[],more:false,counts:{active:0,inactive:0,withdrawn:0}};
 const b=browser({pathname:'/codenotekyh',fetchReply:()=>new Promise(resolve=>resolvers.push(resolve))});
 b.run("regions={'서울':['동부','서부']};scopes.members={regional:true,area:'서울 동부'}");const old=b.run('membersPage()');b.run("scopes.members.area='서울 서부'");const latest=b.run('membersPage()');
 resolvers[0](page);await old;resolvers[1](page);await latest;assert.match(b.element('#app').innerHTML,/서울 서부/);assert.doesNotMatch(b.element('#app').innerHTML,/서울 동부 · 가입/);
});


test('관리자 메인은 링크세팅으로 통합하고 30일 미접속 메뉴는 가입자 현황 안에 둔다',async()=>{
 const requests=[],b=browser({pathname:'/codenotekyh',fetchReply:url=>{requests.push(url);return {items:[],more:false,counts:{active:3,inactive:1,withdrawn:0}};}});
 await b.run('adminHome()');const home=b.element('#app').innerHTML;assert.match(home,/id="linkSettings"/);assert.doesNotMatch(home,/id="url"|id="downloadLinks"|id="inactiveMembers"/);
 await b.element('#members').handlers.click({});assert.match(b.element('#app').innerHTML,/id="members-all" aria-pressed="true"/);assert.match(b.element('#app').innerHTML,/id="members-inactive"/);
 await b.element('#members-inactive').handlers.click({});assert.equal(requests.at(-1),'/api/admin/members?offset=0&filter=inactive');assert.match(b.element('#app').innerHTML,/id="members-inactive" aria-pressed="true"/);
 await b.element('#members-all').handlers.click({});assert.equal(requests.at(-1),'/api/admin/members?offset=0');
});


test('관리자 메인 다섯 메뉴는 지정한 순서이며 일반·긴급공지는 공지설정 안에서 연다',async()=>{
 const b=browser({pathname:'/codenotekyh',fetchReply:url=>url.includes('urgent')?{enabled:false,title:'긴급공지',body:''}:url.includes('announcement')?{enabled:false,title:'공지',body:'',androidEnabled:false,iosEnabled:false,androidUrl:'',iosUrl:''}: {}});
 await b.run('adminHome()');const html=b.element('#app').innerHTML;
 assert.deepEqual([...html.matchAll(/<button id="([^"]+)" class="menu /g)].map(m=>m[1]),['members','monitor','announcements','linkSettings','reset']);
 assert.match(html,/가입자 현황/);assert.match(html,/대화 모니터링/);assert.match(html,/공지설정/);assert.match(html,/링크관리/);assert.match(html,/서버초기화/);
 await b.element('#announcements').handlers.click({});assert.match(b.element('#app').innerHTML,/id="announcement"/);assert.match(b.element('#app').innerHTML,/id="urgentAnnouncement"/);
 await b.element('#urgentAnnouncement').handlers.click({});assert.match(b.element('#app').innerHTML,/긴급공지 설정/);await b.element('#back').handlers.click({});assert.match(b.element('#app').innerHTML,/id="announcement"/);
 await b.element('#announcement').handlers.click({});await b.element('#back').handlers.click({});assert.match(b.element('#app').innerHTML,/id="urgentAnnouncement"/);
});


test('관리자 삭제 확인은 탈퇴와 같은 즉시 대화 삭제 및 24시간 현황 보관을 안내한다',async()=>{
 const writes=[],b=browser({pathname:'/codenotekyh',fetchReply:(url,options)=>{writes.push([url,JSON.parse(options.body)]);return {};}});
 b.run("deleteMember({id:'target',nick:'삭제 대상'},async()=>{})");const html=b.element('dialog1').innerHTML;
 assert.match(html,/탈퇴 처리/);assert.match(html,/양쪽 메시지·사진이 즉시 삭제/);assert.match(html,/관리자 대화 기록도 삭제/);assert.match(html,/24시간/);assert.doesNotMatch(html,/기록은 보관됩니다/);
 await b.element('#proceed').onclick();assert.deepEqual(writes,[['/api/admin/members/target/delete',{confirm:true}]]);
});

test('삭제된 회원의 모니터링 상세는 이전 프로필 원문을 남기지 않고 목록으로 돌아간다',async()=>{
 const paths=[],b=browser({pathname:'/codenotekyh',fetchReply:url=>{paths.push(url);return url.includes('member=gone')?{$status:404,$body:{error:'탈퇴한 회원입니다.'}}:[];}});
 await b.run("monitorRooms({id:'gone',nick:'삭제된 이름',memo:'남으면 안 되는 소개글',area:'서울 동부',year:1995,gender:'여성'})");
 assert.equal(paths.at(-1),'/api/admin/monitor/profiles');assert.doesNotMatch(b.element('#app').innerHTML,/남으면 안 되는 소개글|삭제된 이름/);
});

test('관리자 열람 중 방이 삭제되면 대화 원문과 제목을 지우고 이전 목록으로 돌아간다',async()=>{
 const b=browser({pathname:'/codenotekyh',fetchReply:()=>({$status:404,$body:{error:'대화방을 찾을 수 없어요.'}})});
 await b.run("conversation('gone','지워질 상대',true,()=>paint('대화 모니터링','chat','새 목록'))");
 assert.match(b.element('#app').innerHTML,/새 목록/);assert.doesNotMatch(b.element('#app').innerHTML,/지워질 상대/);assert.equal(b.element('#log').innerHTML,'');
});

test('개인정보 방침은 관리자 회원 삭제도 동일 탈퇴이며 대화를 보관하지 않는다고 설명한다',()=>{
 const copy=JSON.stringify(privacySections);assert.match(copy,/회원탈퇴·운영자의 회원 삭제/);assert.match(copy,/관리자 대화 기록도 함께 삭제/);assert.doesNotMatch(copy,/기존 프로필과 대화 기록이 남는 조치/);
});


test('열린 채팅에서 글·사진의24시간만료는 DOM만 제거하고 초안과 남은 기록을 유지한다',async()=>{
 let now=Date.now();const end=now+1000,rows=[{id:1,author:'b',nick:'상대',body:'사라질 글',sent:now-86400000+1000,expiresAt:end,visibility:'visible'},{id:2,author:'b',nick:'상대',sent:now-86400000+1000,expires:end,expiresAt:end,viewable:1,visibility:'visible'},{id:3,author:'b',nick:'상대',body:'남을 글',sent:now,expiresAt:now+86400000,visibility:'visible'}];
 for(const isAdmin of [false,true]){
  const b=browser({clockNow:()=>now,pathname:isAdmin?'/codenotekyh':'/',fetchReply:url=>url.includes('/messages')?rows:{total:0}});b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',"+isAdmin+",rooms,'b')");b.element('#body').value='작성하던 글';b.element('#body').selectionStart=2;
  const timer=b.timeouts.get(b.run('contentExpiryTimer'));now=end;timer.fn();
  assert.doesNotMatch(b.element('#log').innerHTML,/사라질 글|data-message="2"/);assert.match(b.element('#log').innerHTML,/남을 글/);assert.equal(b.element('#body').value,'작성하던 글');assert.equal(b.element('#body').selectionStart,2);
  assert.equal(b.run('message('+JSON.stringify(rows[0])+','+isAdmin+')'),'');now=end-1000;
 }
});

test('만료 타이머는 화면 이동 때 해제되고 신고 검토의 원문과 사진도 만료시 제거한다',async()=>{
 let now=Date.now();const end=now+1000,b=browser({pathname:'/codenotekyh',clockNow:()=>now,fetchReply:()=>({})});
 b.run('reviewItem('+JSON.stringify({id:1,nick:'상대',message:2,photo:2,expiresAt:end,excerptExpiresAt:end,excerpt:'만료될 신고 원문'})+',false)');
 const timer=b.timeouts.get(b.run('contentExpiryTimer'));assert.ok(timer);now=end;timer.fn();
 assert.match(b.element('#preview').innerHTML,/24시간이 지나 삭제/);assert.equal(b.element('#showPhoto').disabled,true);
 b.run("paint('다른 화면','book','안전한 화면')");assert.equal(b.run('contentExpiryTimer'),null);timer.fn();assert.match(b.element('#app').innerHTML,/안전한 화면/);
});


test('백그라운드 타이머가 늦어져도 복귀 확인 후 가림막을 걷기 전에 만료 원문을 지운다',async()=>{
 let now=Date.now();const end=now+1000,b=browser({clockNow:()=>now,fetchReply:url=>url.includes('/messages')?[{id:1,author:'b',nick:'상대',body:'복귀시 사라질 원문',sent:now,expiresAt:end,visibility:'visible'}]:url.startsWith('/api/status')?{stage:'member',memberId:'a'}:{total:0}});
 b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',false,rooms,'b')");b.run('veil(true)');now=end;await b.run('pulse(true)');
 assert.doesNotMatch(b.element('#log').innerHTML,/복귀시 사라질 원문/);assert.equal(b.element('#lockscreen').hidden,true);
 b.run("paint('새 화면','book','다른 내용')");assert.equal(b.run('contentExpiryCheck'),null);
});

test('과거 페이지 재검증이 지연돼도 표시 중인 글·사진은 두 차례 만료되고 늦은 응답으로 복원되지 않는다',{timeout:2000},async()=>{
 let now=Date.now(),version='1',releaseHistory,historyStarted;
 const firstDeadline=now+1000,secondDeadline=now+2000,waiting=new Promise(resolve=>{historyStarted=resolve;});
 const rows=Array.from({length:180},(_,index)=>{
  const id=index+1,expiresAt=id<=60?firstDeadline:id<120?secondDeadline:now+86400000;
  return {id,author:'peer',nick:'상대',sent:expiresAt-86400000,expiresAt,visibility:'visible',
   ...(id===2||id===62?{expires:expiresAt,viewable:1}:{body:id===1?'첫 시점에 사라질 원문':id===61?'두 번째 시점에 사라질 원문':id===120?'유효한 과거 기록':'유효한 기록 '+id})};
 });
 const b=browser({pathname:'/',clockNow:()=>now,fetchReply:url=>{
  if(!url.includes('/messages'))return {total:0};
  const before=Number(new URL(url,'https://example.com').searchParams.get('before'))||Infinity;
  const response={$roomVersion:version,$body:rows.filter(message=>message.id<before).slice(-60)};
  if(version==='2'&&before===121)return new Promise(resolve=>{releaseHistory=()=>resolve(response);historyStarted();});
  return response;
 }});
 b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',false,rooms,'peer')");
 await b.element('#older').handlers.click({});await b.element('#older').handlers.click({});
 const log=b.element('#log'),composer=b.element('#body');
 assert.equal([...log.innerHTML.matchAll(/data-message="/g)].length,180);
 assert.match(log.innerHTML,/\/api\/photos\/2"/);assert.match(log.innerHTML,/\/api\/photos\/62"/);
 composer.value='계속 작성 중인 초안';composer.selectionStart=2;composer.selectionEnd=6;
 log.scrollHeight=2000;log.clientHeight=200;log.scrollTop=400;log.handlers.scroll({});
 const preserved=()=>{
  assert.match(log.innerHTML,/유효한 과거 기록/);assert.match(log.innerHTML,/유효한 기록 180/);
  assert.equal(composer.value,'계속 작성 중인 초안');assert.equal(composer.selectionStart,2);assert.equal(composer.selectionEnd,6);
 };
 version='2';const refreshing=b.run('roomEventHandler({refresh:true})');await waiting;
 const firstTimer=b.timeouts.get(b.run('contentExpiryTimer'));assert.ok(firstTimer);
 now=firstDeadline;firstTimer.fn();
 assert.doesNotMatch(log.innerHTML,/첫 시점에 사라질 원문|data-message="2"/);
 assert.match(log.innerHTML,/두 번째 시점에 사라질 원문/);assert.match(log.innerHTML,/\/api\/photos\/62"/);preserved();
 const secondTimer=b.timeouts.get(b.run('contentExpiryTimer'));assert.ok(secondTimer);assert.notEqual(secondTimer,firstTimer);
 assert.equal(secondTimer.ms,1000);now=secondDeadline;secondTimer.fn();
 assert.doesNotMatch(log.innerHTML,/첫 시점에 사라질 원문|두 번째 시점에 사라질 원문|data-message="(?:2|62)"/);preserved();
 assert.equal([...log.innerHTML.matchAll(/data-message="/g)].length,61);
 // This response was captured before either deadline, including expired rows.
 releaseHistory();await refreshing;
 assert.doesNotMatch(log.innerHTML,/첫 시점에 사라질 원문|두 번째 시점에 사라질 원문|data-message="(?:2|62)"/);preserved();
 assert.equal([...log.innerHTML.matchAll(/data-message="/g)].length,61);
});
