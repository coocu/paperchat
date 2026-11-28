import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext,runInContext } from 'node:vm';
const source=readFileSync(new URL('../public/web-push-worker.js',import.meta.url),'utf8');
const payload={kind:'chat',event:'job',device:'12345678-1234-1234-1234-123456789abc',message:12};
function worker({notify=true,fail=false,clients=[],verified}={}){
  const events=new Map(),calls=[],notifications=[],opened=[];
  const ctx=createContext({URL,encodeURIComponent,self:{location:{origin:'https://paperchat.example'},addEventListener:(name,fn)=>events.set(name,fn),
    skipWaiting(){},clients:{claim:async()=>{},matchAll:async()=>clients,openWindow:async url=>opened.push(url)},
    registration:{showNotification:async(title,options)=>notifications.push({title,...options})}},
    fetch:async(url,options)=>{calls.push({url,options});if(fail)throw Error('offline');return {ok:true,json:async()=>verified??({notify})};}});
  runInContext(source,ctx);
  return {events,calls,notifications,opened,async push(data=payload){let pending;events.get('push')({data:{json:()=>data},waitUntil:p=>pending=p});await pending;}};
}
test('서비스워커는 서버의 현재 세션 검증 뒤 원문·사진·닉네임 없는 안내만 표시한다',async()=>{
 const w=worker();await w.push();assert.equal(w.notifications.length,1);
 assert.equal(w.calls[0].options.credentials,'include');assert.equal(w.calls[0].options.cache,'no-store');
 assert.match(w.calls[0].url,/device=12345678.*message=12/);
 assert.equal(w.notifications[0].body,'새 대화 또는 답장이 도착했어요.');assert.equal(w.notifications[0].data.url,'/?inbox=1');
 assert.equal(w.events.has('fetch'),false);
});
test('로그아웃·계정 변경·삭제 등 서버가 거절하거나 확인할 수 없는 푸시는 표시하지 않는다',async()=>{
 for(const options of [{notify:false},{fail:true}]){const w=worker(options);await w.push();assert.equal(w.notifications.length,0);}
 for(const data of [null,{}, {...payload,message:'12'},{...payload,device:'../../admin'},{...payload,message:-1}]){
  const w=worker();await w.push(data);assert.equal(w.calls.length,0);assert.equal(w.notifications.length,0);
 }
});
test('알림 클릭은 회원 화면만 다시 열고 관리자·외부 주소는 사용하지 않는다',async()=>{
 const calls=[],client={url:'https://paperchat.example/app',navigate:async url=>calls.push(url),focus:async()=>calls.push('focus')};
 for(const found of [true,false]){
  const w=worker({clients:[{url:'https://evil.example/'},{url:'https://paperchat.example/codenotekyh'},...(found?[client]:[])]});
  let pending;w.events.get('notificationclick')({notification:{data:{url:'https://evil.example/'},close:()=>calls.push('close')},waitUntil:p=>pending=p});await pending;
  if(found)assert.deepEqual(calls,['close','/app?inbox=1','focus']);else assert.deepEqual(w.opened,['/?inbox=1']);
 }
});

test('소식 푸시는 확인된 종류와 사진 ID만 사용하고 댓글 작성자와 원문을 알림에 넣지 않는다',async()=>{
 const event='87654321-4321-4321-4321-cba987654321';
 for(const newsType of ['like','comment']){
  const w=worker({verified:{notify:true,postId:7,newsType}});
  await w.push({kind:'news',event,device:payload.device,postId:7,newsType,author:'비공개 작성자',body:'노출되면 안 되는 댓글'});
  assert.equal(w.notifications.length,1);assert.match(w.calls[0].url,/kind=news&postId=7&event=/);
  assert.equal(w.calls[0].options.credentials,'include');assert.equal(w.notifications[0].data.url,'/?news=7');
  assert.equal(w.notifications[0].body,newsType==='like'?'회원님의 소식에 좋아요가 달렸어요.':'회원님의 소식에 새 댓글이 달렸어요.');
  assert.doesNotMatch(JSON.stringify(w.notifications),/비공개 작성자|노출되면 안 되는 댓글/);
 }
});

test('소식 푸시는 잘못된 ID·종류·이벤트나 검증 불일치·접근 종료 응답에서 표시하지 않는다',async()=>{
 const data={kind:'news',event:'87654321-4321-4321-4321-cba987654321',device:payload.device,postId:7,newsType:'like'};
 for(const patch of [{postId:'7'},{postId:0},{postId:Number.MAX_SAFE_INTEGER+1},{newsType:'private'},{event:'../../admin'}]){
  const w=worker();await w.push({...data,...patch});assert.equal(w.calls.length,0);assert.equal(w.notifications.length,0);
 }
 for(const verified of [{notify:false},{notify:true},{notify:true,postId:8,newsType:'like'},{notify:true,postId:7,newsType:'unknown'}]){
  const w=worker({verified});await w.push(data);assert.equal(w.notifications.length,0);
 }
 const offline=worker({fail:true});await offline.push(data);assert.equal(offline.notifications.length,0);
});

test('소식 알림을 누르면 검증된 양수 사진 ID로 회원 화면을 열며 임의 URL을 따르지 않는다',async()=>{
 for(const existing of [false,true]){
  const actions=[],client={url:'https://paperchat.example/app',navigate:async url=>actions.push(url),focus:async()=>actions.push('focus')};
  const w=worker({clients:existing?[client]:[]});let pending;
  w.events.get('notificationclick')({notification:{data:{kind:'news',postId:7,url:'https://evil.example/admin'},close(){}},waitUntil:p=>pending=p});await pending;
  if(existing)assert.deepEqual(actions,['/app?news=7','focus']);else assert.deepEqual(w.opened,['/?news=7']);
 }
 const w=worker();let pending;w.events.get('notificationclick')({notification:{data:{kind:'news',postId:'../codenotekyh'},close(){}},waitUntil:p=>pending=p});await pending;assert.deepEqual(w.opened,['/?inbox=1']);
});
