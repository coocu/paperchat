import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext,runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { policyVersion,reasons,rules } from '../public/rules.js';

// Exercise the actual WebView controller with an isolated DOM and HTTP adapter.
// The real native shells use the same controller.
const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  .replace(/^import [^\n]+\n/,'').replace('start().catch(', 'Promise.resolve().catch(');
function browser({version,search='',fetchReply}){
  const nodes=new Map(),local=new Map(),session=new Map();
  if(version)local.set('paperchat.reset',version);
  function element(k){
    if(!nodes.has(k))nodes.set(k,{
      innerHTML:'',textContent:'',hidden:true,handlers:{},
      addEventListener(e,cb){this.handlers[e]=cb;},
      insertAdjacentHTML(where,html){this.innerHTML+=html;},
      replaceChildren(){this.innerHTML='';}
    });
    return nodes.get(k);
  }
  const storage=map=>({getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),clear:()=>map.clear()});
  const location={pathname:'/app',search,replace(url){this.redirect=url;}};
  const ctx=createContext({document:{querySelector:element,querySelectorAll:()=>[],hidden:false,addEventListener(){}},
    location,window:{addEventListener(){},scrollTo(){}},setInterval:()=>42,clearInterval(){},setTimeout:()=>7,clearTimeout,AbortController,
    policyVersion,reasons,rules,sessionStorage:storage(session),localStorage:storage(local),
    URLSearchParams,fetch:async(url)=>{const r=fetchReply(url);return {ok:true,status:200,headers:{get:k=>k==='X-Service-Version'?r.version:null},json:async()=>r};}});
  runInContext(script,ctx);
  return {run:code=>runInContext(code,ctx),element,local,location,session};
}
test('열린 앱에서 초기화를 감지하면 현재 화면과 가입 초안을 지우고 사용자 정보 없음 안내로 이동한다',async()=>{
  const b=browser({version:'old',fetchReply:()=>({version:'fresh',stage:'gate'})});
  b.element('#app').innerHTML='이전 회원의 대화';b.session.set('draft','이전 정보');
  b.run("stage='member';me={nick:'이전 회원'};draft.memo='입력중';selectedArea='경기도 이천시'");
  await b.run('pulse(true)');
  assert.equal(b.location.redirect,'/app?reset=1');assert.equal(b.element('#app').innerHTML,'');assert.equal(b.session.size,0);
  assert.equal(b.run('me'),null);assert.equal(b.run('draft.memo'),'');assert.equal(b.local.get('paperchat.reset'),'fresh');
  const reloaded=browser({version:'fresh',search:'?reset=1',fetchReply:()=>({version:'fresh',stage:'gate'})});
  await reloaded.run('boot()');assert.match(reloaded.element('#error').textContent,/등록된 사용자 정보가 없습니다/);
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
  assert.match(gate,/class="invite-stack"/);
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
