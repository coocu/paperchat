import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext,runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { policyVersion,reasons,rules } from '../public/rules.js';

// Exercise the actual WebView controller with an isolated DOM and HTTP adapter.
// The real native shells use the same controller.
const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  .replace(/^import [^\n]+\n/,'').replace('start().catch(', 'Promise.resolve().catch(');
function browser({version,search='',userAgent='',pathname='/app',EventSource,fetchReply}){
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
  const location={pathname,search,replace(url){this.redirect=url;}};
  const ctx=createContext({document:{querySelector:s=>s==='dialog[open]'?[...nodes.values()].find(el=>el.open)||null:element(s),querySelectorAll:()=>[],createElement:tag=>element(tag+ ++dialogId),hidden:false,addEventListener:(name,fn)=>events.set(name,fn)},navigator:{userAgent},
    location,window:{EventSource,addEventListener:(name,fn)=>events.set(name,fn),scrollTo(){}},setInterval:(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:()=>7,clearTimeout,AbortController,
    policyVersion,reasons,rules,sessionStorage:storage(session),localStorage:storage(local),
    Option:class { constructor(text,value){this.text=text;this.value=value;} },
    FormData:class { constructor(form){this.form=form;}get(key){return this.form.values?.[key]??'';} },
    URLSearchParams,fetch:async(url,options)=>{const r=await fetchReply(url,options),status=r?.$status||200;return {ok:status>=200&&status<300,status,headers:{get:k=>k==='X-Service-Version'?r?.version:k==='X-Room-Version'?r?.$roomVersion:null},json:async()=>r?.$body??r};}});
  runInContext(script,ctx);
  return {run:code=>runInContext(code,ctx),element,local,location,session,intervals,events};
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
  await b.element('#existing').handlers.click({});
  assert.match(b.element('#app').innerHTML,/개인 복구코드/);
  assert.deepEqual(requests,['/api/state']);
  b.run("draft.nick='채팅';details()");
  const page=b.element('#app').innerHTML;
  assert.match(page,/생년월일/);assert.match(page,/type="date"/);assert.match(page,/남자/);assert.match(page,/여자/);
  assert.match(page,/만 19세/);assert.doesNotMatch(page,/전화번호|통신사/);
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

test('관리자 대화 목록은 전체로 열리고 참여자별 지역을 구분한다',async()=>{
  const paths=[];
  const b=browser({fetchReply:url=>{paths.push(url);return [{id:'r',first:'가을',firstArea:'경기도 이천시',second:'겨울',secondArea:'서울특별시 중구'}];}});
  await b.run('monitor()');
  assert.deepEqual(paths,['/api/admin/rooms']);
  assert.match(b.element('#app').innerHTML,/aria-pressed="true">전체/);
  assert.match(b.element('#list').innerHTML,/가을 \(경기도 이천시\) · 겨울 \(서울특별시 중구\)/);
});

test('프로필과 내 대화는 전체로 시작하고 선택한 시·군·구로 정확히 전환한다',async()=>{
  for(const entry of ['people','rooms']){
    const requests=[];
    const b=browser({fetchReply:url=>{
      requests.push(url);
      if(url==='/api/regions')return {'경기도':['이천시','여주시'],'서울특별시':['중구']};
      return [{id:'other',nick:'봄',year:1995,gender:'여성',area:'경기도 이천시'}];
    }});
    b.run("me={area:'경기도 이천시'}");
    await b.run(entry+'()');
    assert.deepEqual(requests,['/api/'+entry]);
    assert.match(b.element('#list').innerHTML,/경기도 이천시/);
    await b.element('#scope-area').handlers.click({});
    assert.equal(requests.at(-1),'/api/'+entry+'?area='+encodeURIComponent('경기도 이천시'));
    b.element('#district').value='여주시';b.element('#district').onchange();
    assert.equal(requests.at(-1),'/api/'+entry+'?area='+encodeURIComponent('경기도 여주시'));
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
  for(const pathname of ['/app','/admin']){
    const b=browser({pathname,fetchReply:()=>({$status:401,$body:{error:'코드 확인'}})});
    b.run(pathname==='/admin'?'adminLogin()':'loginPage()');const html=b.element('#app').innerHTML;
    await assert.rejects(b.run(pathname==='/admin'?"api('admin/settings')":"api('account/login',{code:'wrong'})"),e=>e.status===401&&!e.stale);
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

test('내 메시지 삭제는 원본 보관을 확인하고 즉시 제거하며 늦은 폴링에도 다시 나타나지 않는다',async()=>{
  const own={id:1,author:'a',nick:'나',body:'삭제할 메시지',sent:1};const requests=[];
  const b=browser({fetchReply:(url,options)=>{requests.push([url,options.body]);if(url.includes('/messages'))return [own];return {total:0};}});
  b.run("stage='member';me={id:'a'}");await b.run("conversation('r','대화',false,rooms,'b')");
  assert.match(b.element('#log').innerHTML,/data-delete-message="1"/);
  await b.element('#log').handlers.click({target:{closest:s=>s==='[data-delete-message]'?{dataset:{deleteMessage:'1'}}:null}});
  assert.match(b.element('dialog1').innerHTML,/관리자는 원래 대화에서 확인/);assert.match(b.element('dialog1').innerHTML,/사진은 전송 후 12시간/);
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
  const b=browser({pathname:'/admin',fetchReply:()=>[
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
  const paths=[];const b=browser({pathname:'/admin',fetchReply:(url,options)=>{
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
