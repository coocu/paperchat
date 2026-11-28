import {policyVersion,rules,reasons} from './rules.js';
import {privacyEffectiveDate,privacyIntro,privacySections} from './privacy.js';
import {createNewsUI} from './news.js';
const main=document.querySelector('#app');
const adminPath='/codenotekyh';
const admin=location.pathname===adminPath;
const memberPath=location.pathname==='/app'?'/app':'/';
const nativeClient=/PaperChat(?:Android|IOS)/i.test(navigator.userAgent||'')
  || Boolean(window.webkit?.messageHandlers?.paperChatPush) || typeof window.paperChatNativeForeground==='boolean';
const desktopDownloads=(()=>{
  const ua=navigator.userAgent||'',platform=navigator.platform||'';
  if(/PaperChat(?:Android|IOS)/i.test(ua)||window.webkit?.messageHandlers?.paperChatPush||typeof window.paperChatNativeForeground==='boolean')return false;
  if(navigator.userAgentData?.mobile||/Mobile|iPhone|iPad|iPod|Android/i.test(ua))return false;
  if((/Macintosh/i.test(ua)||platform==='MacIntel')&&navigator.maxTouchPoints>1)return false;
  return /Windows|Macintosh|X11|Linux|CrOS/i.test(ua);
})();
if(admin)document.title='종이편지 · 운영자 관리실';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
  mail:'<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="m3 7 9 7 9-7"/>',
  key:'<circle cx="8" cy="9" r="5"/><path d="m11.5 12.5 7 7 3-3-2-2-2 1"/>',
  book:'<path d="M4 4h13a2 2 0 0 1 2 2v14H5a2 2 0 0 1-2-2V6a2 2 0 0 1 1-2Zm2 0v16m3-10h7m-7 3h5"/>',
  pen:'<path d="m5 16 11-11 3 3L8 19l-5 2zm9-9 3 3m-6 10h10"/>',
  pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  chat:'<path d="M3 5h18v12H9l-5 4v-4H3zM7 9h10m-10 4h7"/>',
  settings:'<path d="M3 7h18M3 17h18"/><circle cx="9" cy="7" r="2.5"/><circle cx="15" cy="17" r="2.5"/>',
  bin:'<path d="M3 6h18M8 6V3h8v3m-11 0 1 14h12l1-14M10 9v7m4-7v7"/>',
  leaf:'<path d="M4 19C1 9 11 3 21 3c0 10-5 18-15 15m-3 3L16 8"/>',
  arrow:'<path d="m9 5 7 7-7 7"/>',photo:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m4 17 5-6 4 4 3-3 5 5"/><circle cx="16" cy="9" r="1.5"/>'
};
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[n]||paths.mail}</svg>`;
let me,regions,stage,activeTimer,contentExpiryTimer=null,contentExpiryCheck=null,epoch=0,currentBack=null,backBusy=false,unreadTotal=0,unreadRequest=0,accountState={};
let accountRevision=0,bootSerial=0,presenceTimer=null,nativeForeground=window.paperChatNativeForeground!==false,pageForeground=true,lastPresence=null,lastPresenceAt=0;
let memberEvents=null,roomEventHandler=null,chatLayout=null,memberViewReady=false,newsUI=null;
const memberStages=new Set(['member','restricted','policy']);
const hasMemberSession=()=>memberStages.has(stage);
const currentMemberId=()=>me?.id||accountState.memberId||null;
const staleRequest=()=>Object.assign(new Error('화면이 변경되어 이전 요청을 종료했어요.'),{stale:true});
// Native Android back and the iOS edge gesture share the same screen navigation.
window.paperChatBack=()=>{
  if(urgentDialog?.open)return true;
  const dialog=document.querySelector('dialog[open]');
  if(dialog){dialog.close();return true;}
  if(backBusy)return true;
  if(!currentBack)return false;
  backBusy=true;
  Promise.resolve().then(currentBack).catch(err).finally(()=>{backBusy=false;});
  return true;
};
function fitViewport(){
  const viewport=window.visualViewport;
  const height=viewport?.height||window.innerHeight;
  if(!height)return;
  document.documentElement.style.setProperty('--app-height',height+'px');
  document.documentElement.style.setProperty('--app-top',(viewport?.offsetTop||0)+'px');
  chatLayout?.resize();
}
window.visualViewport?.addEventListener('resize',fitViewport);
window.visualViewport?.addEventListener('scroll',fitViewport);
window.addEventListener('resize',fitViewport);
fitViewport();
const scopes={people:{},rooms:{},news:{},adminNews:{},monitor:{},members:{}};
function resetScopes(){for(const scope of Object.values(scopes)){scope.regional=false;scope.area='';}}
const draft={nick:'',birthDate:'',gender:'',province:'',district:'',memo:''};
const err=e=>{if(e?.stale)return;const el=$('#error');if(el)el.textContent=e.message||String(e);};
const note=msg=>{const el=$('#notice');if(!el)return;el.textContent=msg;setTimeout(()=>{if(el.textContent===msg)el.textContent='';},3200);};
async function api(path,body,{keepalive=false}={}) {
  if(leaving)throw staleRequest();
  const revision=accountRevision,view=epoch;
  const memberRequest=!admin&&hasMemberSession()&&!path.startsWith('admin/')&&!['key','account/login'].includes(path);
  const memberId=currentMemberId();
  const expectedMember=!admin&&memberId&&!path.startsWith('admin/')&&!['status','key','account/login'].includes(path)?memberId:null;
  const headers=body===undefined?{}:{'Content-Type':'application/json'};
  if(expectedMember)headers['X-PaperChat-Member']=expectedMember;
  const background=['status','presence','unread','push/device','push/web','push/web-config','urgent-announcement'].includes(path);
  const controller=['status','presence'].includes(path)?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),8000):null;
  let res;
  try{res=await fetch('/api/'+path+(path==='status' && !admin?'?member=1':''),{signal:controller?.signal,method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',keepalive});}finally{if(timer)clearTimeout(timer);}
  if(revision!==accountRevision)throw staleRequest();
  const version=res.headers.get('X-Service-Version');
  if(version)recordVersion(version);
  const data=await res.json();
  if(revision!==accountRevision)throw staleRequest();
  if(!admin&&!res.ok&&res.status===409&&data.code==='ACCOUNT_CHANGED'){
    reloadMemberAccount();throw staleRequest();
  }
  if(!res.ok&&res.status===401&&memberRequest){
    clearMemberSession('사용자 정보가 없거나 로그인이 종료되었어요. 다시 인증해 주세요.');
    throw staleRequest();
  }
  if(!background&&view!==epoch)throw staleRequest();
  if(Array.isArray(data))data.roomVersion=res.headers.get('X-Room-Version');
  if(!res.ok){const e=new Error(data.error||'요청에 실패했어요.');e.status=res.status;throw e;}
  return data;
}
function clearMemberSession(message=''){
  accountRevision++;bootSerial++;unreadRequest++;
  closeMemberEvents();
  clearInterval(activeTimer);clearInterval(presenceTimer);presenceTimer=null;
  me=null;accountState={};stage='gate';unreadTotal=0;nextPushSync=0;announcementRequested=false;memberViewReady=false;
  urgentChecked=false;urgentSeenRevision=null;urgentData=null;nextUrgentSync=0;
  currentBack=null;backBusy=false;lastPresence=null;lastPresenceAt=0;resetScopes();
  for(const key of Object.keys(draft))draft[key]='';
  sessionStorage.clear();closeDialogs();main.replaceChildren();veil(false);gate();
  if(message)err(new Error(message));
}
function reloadMemberAccount(){
  if(leaving)return;
  leaving=true;
  clearMemberSession();main.replaceChildren();
  veil(true,'로그인 계정이 변경되어 다시 불러오고 있어요.');
  location.replace(memberPath);
}
const foregroundVisible=()=>nativeForeground&&pageForeground&&!document.hidden;
function presenceVisible(){return !admin&&hasMemberSession()&&foregroundVisible()&&navigator.onLine!==false;}
function closeMemberEvents(){
  const source=memberEvents;memberEvents=null;source?.close();
}
function syncMemberEvents(){
  if(stage!=='member'||!presenceVisible()||typeof window.EventSource!=='function'){closeMemberEvents();return;}
  if(memberEvents)return;
  const revision=accountRevision;
  let source;
  try{source=new window.EventSource('/api/events');}catch{return;}
  memberEvents=source;
  const current=()=>source===memberEvents&&revision===accountRevision&&stage==='member'&&presenceVisible();
  source.addEventListener('room-change',event=>{
    if(!current())return;
    let change;try{change=JSON.parse(event.data);}catch{return;}
    if(!change||typeof change.room!=='string')return;
    Promise.resolve(roomEventHandler?.(change)).catch(err);void syncUnread();
  });
  source.addEventListener('urgent-announcement',()=>{if(current())void syncUrgentAnnouncement(true);});
  source.addEventListener('news-change',()=>{if(current())newsUI?.handleEvent();});
  source.addEventListener('open',()=>{
    if(!current())return;
    // Fetch changes missed while disconnected without replacing the composer.
    Promise.resolve(roomEventHandler?.({refresh:true})).catch(err);void syncUnread();
    newsUI?.handleEvent();
    void syncUrgentAnnouncement(true);
  });
  source.addEventListener('error',()=>{if(current())void pulse();});
}
async function sendPresence(online,force=false){
  if(admin||!hasMemberSession())return;
  if(!force&&lastPresence===online&&Date.now()-lastPresenceAt<25000)return;
  lastPresence=online;lastPresenceAt=Date.now();const revision=accountRevision;
  try{
    await api('presence',{online},{keepalive:!online});
    // Repair a slow foreground response that arrives after backgrounding, or vice versa.
    if(revision===accountRevision&&hasMemberSession()&&online!==presenceVisible())void sendPresence(presenceVisible(),true);
  }catch(e){if(!e.stale&&revision===accountRevision)lastPresenceAt=0;}
}
function updatePresence(force=false){
  syncMemberEvents();
  const online=presenceVisible();
  if(!online){clearInterval(presenceTimer);presenceTimer=null;}
  else if(!presenceTimer)presenceTimer=setInterval(()=>void sendPresence(presenceVisible(),true),30000);
  if(hasMemberSession())void sendPresence(online,force);
}
window.paperChatPresence=active=>{
  nativeForeground=active===true;updatePresence(true);
  if(nativeForeground)void pulse(true);else veil(true);
};
function on(sel,event,fn) {
  const el=$(sel);if(!el)return;
  el.addEventListener(event,async e=>{
    if(event==='submit')e.preventDefault();
    try{await fn(e);}catch(ex){err(ex);}
  });
}
function form(fn){
  on('form','submit',async e=>{
    const el=e.currentTarget, submit=el.querySelector('[type=submit]');
    if(submit.disabled)return;
    submit.disabled=true;const error=$('#error');if(error)error.textContent='';
    try{await fn(new FormData(el));}finally{submit.disabled=false;}
  });
}
const btn=(label,kind='primary')=>`<button type="submit" class="${kind}">${label}</button>`;
const act=(id,label,style='')=>`<button type="button" id="${id}" class="${style}">${label}</button>`;
function field(id,title,opts=''){return `<div class="field"><label for="${id}">${title}</label><input id="${id}" name="${id}" required ${opts}></div>`;}
const actions=(...parts)=>`<div class="actions">${parts.join('')}</div>`;
const notice='<p class="error" id="error" role="alert"></p>';
function paint(title,mark,body,{sub='',back,wide=false,nav='',headerAction=''}={}) {
  newsUI?.dispose();
  clearTimeout(contentExpiryTimer);contentExpiryTimer=null;contentExpiryCheck=null;
  chatLayout?.dispose();chatLayout=null;
  closeDialogs(!admin&&stage==='member');
  clearInterval(activeTimer);epoch++;roomEventHandler=null;main.className=wide?'wide':'';
  currentBack=back||(nav&&!nav.includes('id="tab-people" class="active"')?people:null);
  back=currentBack;
  main.innerHTML=`<header class="bar"><span class="brand">${icon('mail')}종이편지</span>${back?act('back','이전','textBtn'):headerAction}</header>${nav?`<h1 class="sr-only">${esc(title)}</h1>`:`<section class="hero"><h1>${icon(mark)}${esc(title)}</h1>${sub?`<p>${esc(sub)}</p>`:''}</section>`}${nav}<div id="sections" class="screen-stack">${body}</div>${body.includes(notice)?'':notice}`;
  if(back)on('#back','click',()=>window.paperChatBack());
  on('#privacy','click',privacyPage);
  document.title=title+' · 종이편지';
  window.scrollTo(0,0);
}
function tabs(current){
  return '<nav class="tabs" aria-label="앱 메뉴">'+[['people','프로필 목록'],['rooms','내 대화'],['news','소식']].map(([id,l])=>act('tab-'+id,l+(id==='rooms'?`<span id="unread-total" class="badge" ${unreadTotal?'':'hidden'} aria-label="안 읽은 메시지 ${unreadTotal}개">${unreadTotal>99?'99+':unreadTotal}</span>`:''),id===current?'active':'')).join('')+'</nav>';
}
function wireTabs(){on('#tab-people','click',people);on('#tab-rooms','click',rooms);on('#tab-news','click',news);}
function row(id,title,subtitle,unread=0){return `<button type="button" class="row" data-id="${esc(id)}"><span>${esc(title)}<small>${esc(subtitle)}</small></span>${unread?`<span class="badge" aria-label="안 읽은 메시지 ${unread}개">${unread>99?'99+':unread}</span>`:''}${icon('arrow')}</button>`;}
async function syncUnread(){
  if(admin||stage!=='member'||!foregroundVisible())return;
  const request=++unreadRequest;
  try{
    const data=await api('unread');
    if(request!==unreadRequest||stage!=='member'||!foregroundVisible())return;
    unreadTotal=Math.max(0,Number(data.total)||0);
    const badge=$('#unread-total');
    if(badge){badge.textContent=unreadTotal>99?'99+':String(unreadTotal);badge.hidden=!unreadTotal;badge.setAttribute('aria-label',`안 읽은 메시지 ${unreadTotal}개`);}
  }catch{/* The regular connection check presents offline/account errors. */}
}
function rows(items,fn){
  document.querySelectorAll('.row').forEach(el=>el.onclick=()=>Promise.resolve(fn(items.find(x=>x.id===el.dataset.id))).catch(err));
}
function menu(id,i,title,desc,extra=''){return `<button id="${id}" class="menu ${extra}"><span class="symbol">${icon(i)}</span><span><strong>${title}</strong><small>${desc}</small></span><span class="chev">${icon('arrow')}</span></button>`;}
function modal(title,desc,label,fn){
  const d=document.createElement('dialog');d.className='dialog';d.innerHTML=`<h2>${esc(title)}</h2><p>${esc(desc)}</p>${actions(act('dismiss','취소'),act('proceed',esc(label),'danger fill'))}`;
  main.append(d);d.showModal();d.onclose=()=>d.remove();
  d.querySelector('#dismiss').onclick=()=>d.close();d.querySelector('#proceed').onclick=async()=>{d.close();try{await fn();}catch(e){err(e);}};
}
function closeDialogs(keepUrgent=false){document.querySelectorAll('dialog[open]').forEach(d=>{if(!keepUrgent || d!==urgentDialog)d.close();});}
const rulesCard=(showPrivacy=true)=>`<aside class="letter"><h2>${icon('book')}이용규칙</h2><div class="policy-links">${showPrivacy?act('privacy','개인정보 처리방침','textBtn'):''}<a class="textBtn" href="/support">운영자 문의</a></div><ul>${rules.map(r=>'<li>'+esc(r)+'</li>').join('')}</ul></aside>`;
function privacyPage(){
  if(document.querySelector('dialog[open]'))return;
  // Keep the originating form and its event handlers intact while reading.
  const d=document.createElement('dialog');d.className='dialog privacy-dialog';
  d.setAttribute('aria-labelledby','privacy-title');
  const paragraphs=values=>(values||[]).map(value=>`<p>${esc(value)}</p>`).join('');
  const intro=Array.isArray(privacyIntro)?privacyIntro:[privacyIntro];
  d.innerHTML=`<header class="privacy-header"><div><p class="note">종이편지 · ${esc(privacyEffectiveDate)}</p><h2 id="privacy-title">개인정보 처리방침</h2></div><button type="button" id="privacy-close" autofocus>닫기</button></header><div class="privacy-body" tabindex="0">${paragraphs(intro)}${privacySections.map(section=>`<section><h3>${esc(section.title)}</h3>${paragraphs(section.paragraphs)}${section.bullets?.length?'<ul>'+section.bullets.map(value=>`<li>${esc(value)}</li>`).join('')+'</ul>':''}</section>`).join('')}</div>`;
  main.append(d);d.onclose=()=>d.remove();
  d.querySelector('#privacy-close').onclick=()=>d.close();d.showModal();
}
const resetKey='paperchat.reset';
let leaving=false,knownVersion=localStorage.getItem(resetKey);
function recordVersion(version){
  if(leaving)throw new Error('계정 상태를 갱신하고 있어요.');
  const previous=knownVersion;knownVersion=version;
  localStorage.setItem(resetKey,version);
  if(previous && previous!==version){
    leaving=true;closeMemberEvents();clearInterval(activeTimer);clearInterval(presenceTimer);presenceTimer=null;accountRevision++;bootSerial++;unreadRequest++;epoch++;me=null;accountState={};unreadTotal=0;currentBack=null;roomEventHandler=null;resetScopes();stage='gate';
    for(const k of Object.keys(draft))draft[k]='';
    sessionStorage.clear();
    closeDialogs();main.replaceChildren();location.replace((admin?adminPath:memberPath)+'?reset=1');
    throw new Error('서버가 초기화되어 사용자 정보가 없어요.');
  }
}
function accountActions(){
  on('#logout','click',async()=>{await api('logout',{});clearMemberSession();location.replace(memberPath);});
  on('#withdraw','click',()=>modal('회원탈퇴','프로필과 참여한 대화가 삭제돼요. 관리자 현황에는 닉네임과 탈퇴 시각이 24시간 표시돼요. 일반 재가입은 24시간 후, 이용 제한 중이면 제한 종료 후 가능해요.','탈퇴하기',async()=>{await api('withdraw',{confirm:true});clearMemberSession();location.replace(memberPath);}));
}
function limitedPage(state){
  const policy=state==='policy';
  paint(policy?'이용규칙 확인':'계정 이용 제한','book',rulesCard()+
    (policy?`<form class="paper"><label class="check"><input required type="checkbox">이용규칙에 동의해요</label>${actions(btn('확인하고 계속'))}</form>`:`<section class="paper"><p>신고 검토 결과에 따라 계정 이용이 제한되었어요. 새 신고는 인정 3회마다 24시간 제한이 적용돼요.</p>${accountState.restrictedUntil?`<p>이용 재개: ${esc(at(accountState.restrictedUntil))}</p>`:''}</section>`)+
    actions(act('recovery','개인 복구코드 보기'),act('logout','로그아웃'),act('withdraw','회원탈퇴','danger')));
  if(policy)form(async()=>{await api('policy',{version:policyVersion});await boot();});
  on('#recovery','click',()=>recoveryPage(()=>limitedPage(state)));
  accountActions();
}
function reportUI(target,back){
  paint('신고하기','mail',`<form class="paper"><label for="reason">신고 사유</label><select id="reason" required name="reason"><option value="">선택해 주세요</option>${reasons.map(r=>`<option>${esc(r)}</option>`).join('')}</select><p class="note">${target.kind==='profile'?'신고가 접수되면 처리 결과에 따라 조치해요.':'신고가 접수되면 해당 메시지는 처리 결과가 나올 때까지 숨겨져요.'}</p>${actions(btn('신고 접수'))}</form>`,{back});
  form(async f=>{
    try{await api('report',{...target,reason:f.get('reason')});}
    catch(e){
      if(target.kind==='profile'&&e.status===409){await people();err(new Error('프로필이 변경됐어요. 내용을 다시 확인한 뒤 신고해 주세요.'));return;}
      throw e;
    }
    await back();note('신고를 접수했어요.');
  });
}
function conversationReport(room,refresh){
  const view=epoch,revision=accountRevision,d=document.createElement('dialog');d.className='dialog report-dialog';
  d.setAttribute('aria-labelledby','conversation-report-heading');
  d.innerHTML=`<h2 id="conversation-report-heading">신고하기</h2><form id="conversationReportForm"><label for="conversationReason">신고 사유</label><select id="conversationReason" name="reason" required><option value="">선택해 주세요</option>${reasons.map(r=>`<option>${esc(r)}</option>`).join('')}</select><p class="note">이 대화방에서 상대가 보낸 사진이 모두 검토 중으로 바뀌어요. 이미 삭제되거나 만료된 사진은 다시 표시되지 않아요.</p><p id="conversationReportError" class="error" role="alert"></p>${actions(act('cancelConversationReport','취소'),btn('신고 접수','danger fill'))}</form>`;
  d.onclose=()=>d.remove();main.append(d);d.showModal();
  d.querySelector('#cancelConversationReport').onclick=()=>d.close();
  const f=d.querySelector('#conversationReportForm'),submit=f.querySelector('[type=submit]'),error=d.querySelector('#conversationReportError');
  f.addEventListener('submit',async event=>{
    event.preventDefault();if(submit.disabled)return;submit.disabled=true;error.textContent='';
    try{
      await api('report',{kind:'conversation',room,reason:new FormData(f).get('reason')});
      if(view!==epoch||revision!==accountRevision)return;
      d.close();await refresh();note('신고를 접수했어요. 상대가 보낸 사진은 검토 중으로 표시돼요.');
    }catch(e){if(!e.stale&&view===epoch&&revision===accountRevision)error.textContent=e.message;}
    finally{submit.disabled=false;}
  });
}

function blockPeer(id,back){
  modal('사용자 차단','서로의 프로필이 숨겨지고 두 사람의 채팅방이 삭제돼요. 사진과 글은 전송 후 24시간에 삭제돼요.','차단하기',async()=>{await api('blocks',{peer:id});await back();note('사용자를 차단했어요.');void syncUnread();});
}
async function blockedList(){
  const items=await api('blocks');
  paint('차단한 사용자','settings',`<div class="paper"><div class="rows">${items.map(i=>row(i.id,i.nick,'차단 해제')).join('')||'차단한 사용자가 없어요.'}</div></div>`,{back:settings});
  rows(items,i=>modal('차단 해제',i.nick+'님의 차단을 해제할까요?','해제하기',async()=>{await api('blocks',{peer:i.id,remove:true});await blockedList();}));
}
function gate(){
  paint('인증키를 입력해 주세요','key',`<form class="paper">${field('code','발급받은 일반 인증키','autocomplete="off" maxlength="256" aria-describedby="error" placeholder="인증키 입력"')}${notice}${actions(btn('인증하고 계속'))}</form>
    ${act('existing','기존 회원 로그인','secondary')}
    ${desktopDownloads?'<section class="download-options" aria-label="모바일 앱 다운로드"><div class="download-buttons"><button type="button" id="download-android" disabled>Android 앱 다운로드</button><button type="button" id="download-ios" disabled>iPhone 앱 다운로드</button></div><p id="download-status" class="note" role="status" aria-live="polite"></p><button type="button" id="download-retry" class="textBtn" hidden>다시 시도</button></section>':''}
    <aside class="letter"><h2>${icon('mail')}인증키 발급 안내</h2><p>현재 승인된 인증키로 다음 가입 단계로 이동해요. 같은 인증키를 사용해도 회원 계정은 각각 만들어져요. 기존 계정은 개인 복구코드로 로그인해 주세요.</p><div class="rule"></div><a class="btn forest" href="/apply">발급 신청서 열기</a></aside>
    ${rulesCard()}`);
  on('#existing','click',loginPage);
  form(async f=>{await api('key',{code:f.get('code')});nick();});
  if(desktopDownloads)wireDownloads();
  if(new URLSearchParams(location.search).has('reset'))err(new Error('서버가 초기화되어 등록된 사용자 정보가 없습니다. 다시 가입해 주세요.'));
  if(new URLSearchParams(location.search).has('form'))err(new Error('등록된 발급 주소가 없어요.'));
}
function downloadURL(value){
  if(typeof value!=='string')throw new Error('다운로드 링크를 확인하지 못했어요.');
  const link=value.trim();if(!link)return '';
  let parsed;try{parsed=new URL(link);}catch{throw new Error('https://로 시작하는 올바른 링크를 입력해 주세요.');}
  if(link.length>2048||/[\u0000-\u001f\u007f]/.test(link)||parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password)throw new Error('https://로 시작하는 올바른 링크를 입력해 주세요.');
  return parsed.href;
}
function wireDownloads(){
  const view=epoch,revision=accountRevision,status=$('#download-status'),retry=$('#download-retry');
  const buttons=[$('#download-android'),$('#download-ios')];let links=null,loading=false;
  const current=()=>view===epoch&&revision===accountRevision&&!leaving;
  const load=async()=>{
    if(!current()||loading)return;
    loading=true;links=null;retry.hidden=true;buttons.forEach(button=>button.disabled=true);status.textContent='다운로드 링크를 확인하고 있어요.';
    try{
      const data=await api('download-links');
      if(!current())return;
      links={androidUrl:downloadURL(data.androidUrl),iosUrl:downloadURL(data.iosUrl)};
      buttons.forEach(button=>button.disabled=false);status.textContent='';
    }catch(e){if(current()&&!e.stale){status.textContent='다운로드 링크를 불러오지 못했어요. 다시 시도해 주세요.';retry.hidden=false;}}
    finally{loading=false;}
  };
  for(const [selector,key] of [['#download-android','androidUrl'],['#download-ios','iosUrl']])on(selector,'click',()=>{
    if(!current()||!links)return;
    if(!links[key]){status.textContent='아직 개발 진행중이에요.';return;}
    status.textContent='';window.open(links[key],'_blank','noopener,noreferrer');
  });
  on('#download-retry','click',load);void load();
}
const announcementHideKey='paperchat.announcement.hiddenUntil',announcementHideDuration=4*60*60*1000;
let announcementRequested=false;
let urgentDialog=null,urgentData=null,urgentSeenRevision=null,urgentChecked=false,urgentSync=null,urgentQueued=false,nextUrgentSync=0;
const urgentEligible=()=>!admin && stage==='member' && Boolean(me?.id) && memberViewReady && !leaving && foregroundVisible();
function renderUrgentAnnouncement(){
  if(!urgentEligible())return;
  const data=urgentData;
  if(!data?.enabled || data.revision===urgentSeenRevision){urgentDialog?.close();return;}
  if(urgentDialog?.open && urgentDialog.dataset.revision===data.revision)return;
  urgentDialog?.close();
  const d=document.createElement('dialog');urgentDialog=d;d.className='dialog announcement-dialog urgent-dialog';d.dataset.revision=data.revision;
  d.setAttribute('aria-labelledby','urgent-heading');d.setAttribute('aria-modal','true');
  d.innerHTML=`<header class="announcement-header" tabindex="0"><p class="urgent-label">긴급공지</p><h2 id="urgent-heading">${esc(data.title)}</h2></header>
    <div class="announcement-content" tabindex="0">${esc(data.body)}</div>
    <footer class="announcement-footer"><div class="announcement-buttons">${act('urgent-close','닫기','primary')}</div></footer>`;
  // Keep the page, composer and any ordinary dialog intact underneath this one.
  document.body.append(d);
  d.addEventListener('cancel',event=>event.preventDefault());
  d.onclose=()=>{if(urgentDialog===d)urgentDialog=null;d.remove();};
  d.querySelector('#urgent-close').onclick=()=>{
    urgentSeenRevision=data.revision;d.close();void maybeAnnouncement();
  };
  d.showModal();
}
async function syncUrgentAnnouncement(force=false){
  if(!urgentEligible())return;
  if(urgentSync){if(force)urgentQueued=true;return urgentSync;}
  if(!force && Date.now()<nextUrgentSync)return;
  const revision=accountRevision,member=me.id;
  const current=()=>urgentEligible() && revision===accountRevision && member===me?.id;
  urgentSync=(async()=>{
    do{
      urgentQueued=false;nextUrgentSync=Date.now()+12000;
      const data=await api('urgent-announcement');if(!current())return;
      if(typeof data.enabled!=='boolean' || typeof data.title!=='string' || typeof data.body!=='string'
        || (data.enabled && (typeof data.revision!=='string' || !data.revision)))throw new Error('긴급공지 응답을 확인할 수 없어요.');
      urgentData=data;urgentChecked=true;renderUrgentAnnouncement();
    }while(urgentQueued && current());
  })().catch(()=>{if(current())nextUrgentSync=0;}).finally(()=>{
    urgentSync=null;
    if(current())void maybeAnnouncement();
    // A previous account's request may have finished after a new login.
    else if(urgentEligible())void syncUrgentAnnouncement(true);
  });
  return urgentSync;
}
function announcementHidden(){
  try{
    const until=Number(localStorage.getItem(announcementHideKey)),now=Date.now();
    return Number.isFinite(until) && until>now && until<=now+announcementHideDuration;
  }catch{return false;}
}
function showAnnouncement(data){
  if(admin || stage!=='member' || !me?.id || accountState.needsRecoveryCopy || !data?.enabled || typeof data.title!=='string' || typeof data.body!=='string' || document.querySelector('dialog[open]'))return;
  const showAndroid=!nativeClient && data.androidEnabled,showIos=!nativeClient && data.iosEnabled;
  const links=nativeClient?{}:{androidUrl:downloadURL(data.androidUrl),iosUrl:downloadURL(data.iosUrl)};
  const d=document.createElement('dialog');d.className='dialog announcement-dialog';
  d.setAttribute('aria-labelledby','announcement-heading');
  const appButtons=(showAndroid?act('announcement-android','안드로이드앱','secondary'):'')+(showIos?act('announcement-ios','아이폰앱','secondary'):'');
  d.innerHTML=`<header class="announcement-header" tabindex="0"><h2 id="announcement-heading">${esc(data.title)}</h2></header>
    <div class="announcement-content" tabindex="0">${esc(data.body)}</div>
    <footer class="announcement-footer">${appButtons?`<div class="announcement-buttons" aria-label="앱 다운로드">${appButtons}</div><p id="announcement-status" class="note" role="status" aria-live="polite"></p>`:''}
      <div class="announcement-buttons">${act('announcement-hide','4시간 보지않기')}${act('announcement-close','닫기','primary')}</div>
    </footer>`;
  d.onclose=()=>d.remove();main.append(d);
  for(const [enabled,selector,key] of [[showAndroid,'#announcement-android','androidUrl'],[showIos,'#announcement-ios','iosUrl']])if(enabled)d.querySelector(selector).onclick=()=>{
    const status=d.querySelector('#announcement-status');
    if(!links[key]){status.textContent='아직 개발 진행중이에요.';return;}
    status.textContent='';window.open(links[key],'_blank','noopener,noreferrer');
  };
  d.querySelector('#announcement-hide').onclick=()=>{
    try{localStorage.setItem(announcementHideKey,String(Date.now()+announcementHideDuration));}
    catch{note('이 브라우저에서는 4시간 숨김을 저장할 수 없어요.');}
    d.close();
  };
  d.querySelector('#announcement-close').onclick=()=>d.close();d.showModal();
}
async function maybeAnnouncement(){
  if(admin || stage!=='member' || !me?.id || accountState.needsRecoveryCopy || announcementRequested || announcementHidden() || leaving)return;
  if(!urgentChecked || urgentDialog?.open || urgentQueued)return;
  announcementRequested=true;
  try{
    const data=await api('announcement');
    if(!urgentChecked || urgentDialog?.open || urgentQueued){announcementRequested=false;return;}
    if(!leaving && !announcementHidden())showAnnouncement(data);
  }catch{/* A failed or outdated notice must never interrupt signing in. */}
}
function nick(){
  paint('어떻게 불러드릴까요?','pen',`<form class="paper">${field('nick','닉네임',`value="${esc(draft.nick)}" maxlength="24" placeholder="대화에서 사용할 이름"`)}${actions(btn('다음'))}</form>`,{back:()=>{draft.nick=$('#nick').value;gate();}});
  form(f=>{draft.nick=f.get('nick').trim();details();});
}
function loginPage(){
  paint('다시 로그인','key',`<form class="paper">${field('recovery','개인 복구코드','type="password" autocomplete="off" spellcheck="false" maxlength="64"')}<p class="note">가입할 때 보관한 개인 복구코드를 입력하면 내 프로필과 대화가 열려요.</p>${actions(btn('로그인'))}</form>`,{back:gate});
  form(async f=>{requestWebPushPermission(true);await api('account/login',{code:f.get('recovery')});await boot();});
}
function details(){
  paint('생년월일과 성별','pen',`<form class="paper">${field('birthDate','생년월일',`type="date" autocomplete="bday" min="1900-01-01" value="${esc(draft.birthDate)}"`)}
    <div class="field"><label for="gender">성별</label><select id="gender" name="gender" required><option value="">선택해 주세요</option>${[['남성','남자'],['여성','여자']].map(([v,l])=>`<option value="${v}" ${draft.gender===v?'selected':''}>${l}</option>`).join('')}</select></div>
    <p class="note">직접 입력한 생년월일로 만 19세 이상인지 확인해요. 프로필에는 출생연도와 성별만 표시돼요.</p>
    ${actions(btn('다음'))}</form>`,{back:()=>{draft.birthDate=$('#birthDate').value;draft.gender=$('#gender').value;nick();}});
  form(async f=>{
    draft.birthDate=f.get('birthDate');draft.gender=f.get('gender');
    await api('profile-details',{nick:draft.nick,birthDate:draft.birthDate,gender:draft.gender});
    await regionStep();
  });
}
async function recoveryPage(back){
  const {code}=await api('account/recovery');
  paint('개인 복구코드','key',`<form class="paper"><p>로그아웃하거나 휴대폰을 바꾸면 이 코드로 내 대화를 다시 열 수 있어요. 비밀번호처럼 따로 보관해 주세요.</p>
    <label for="personalCode">내 복구코드</label><input id="personalCode" readonly value="${esc(code)}">
    ${actions(act('copy','코드 복사','secondary'))}<label class="check"><input type="checkbox" required>복구코드를 보관했어요.</label>${actions(btn('확인'))}</form>`,{back});
  on('#copy','click',async()=>{
    try{await navigator.clipboard.writeText(code);note('복구코드를 복사했어요.');}
    catch{const input=$('#personalCode');input.focus();input.select();note('선택된 코드를 길게 눌러 복사해 주세요.');}
  });
  form(async()=>{await api('account/recovery',{saved:true});if(back)await back();else await boot();});
}
function picker(){return '<div class="split"><div><label for="province">지역</label><select id="province"></select></div><div><label for="district">권역</label><select id="district"></select></div></div>';}
function areaOf(){return $('#province').value+' '+$('#district').value;}
function knownArea(area){return Object.entries(regions||{}).some(([region,zones])=>zones.some(zone=>area===region+' '+zone));}
function wirePicker(area='',changed=()=>{},requireChoice=false){
  const a=$('#province'),b=$('#district'),provinces=Object.keys(regions);
  a.replaceChildren();a.required=requireChoice;b.required=requireChoice;
  if(requireChoice)a.add(new Option('지역을 선택해 주세요',''));
  for(const x of provinces)a.add(new Option(x,x));
  const region=knownArea(area)?provinces.find(x=>area.startsWith(x+' ')):null;
  if(region)a.value=region;
  function list(){
    b.replaceChildren();b.disabled=!a.value;
    if(requireChoice)b.add(new Option('권역을 선택해 주세요',''));
    for(const n of regions[a.value]||[])b.add(new Option(n,n));
  }
  list();if(region)b.value=area.slice(region.length+1);
  a.onchange=()=>{list();changed();};b.onchange=changed;
}
async function regionStep(){
  regions||=await api('regions');
  paint('어느 지역에 계세요?','pin',`<form class="paper">${picker()}${actions(btn('다음'))}</form>`,{back:details,sub:'프로필에 표시할 지역과 권역을 선택해 주세요.'});
  wirePicker(draft.province+' '+draft.district,()=>{},true);
  form(()=>{
    if(!knownArea(areaOf()))throw new Error('지역과 권역을 선택해 주세요.');
    draft.province=$('#province').value;draft.district=$('#district').value;memo();
  });
}
function memo(){
  paint('당신은 어떤 사람인가요?','leaf',rulesCard()+`<form class="paper"><label for="memo">당신을 표현해주세요</label><textarea id="memo" name="memo" required maxlength="800" placeholder="나를 소개하는 글을 자유롭게 적어주세요.">${esc(draft.memo)}</textarea><div class="rule"></div><label class="check"><input type="checkbox" required><span>이용규칙에 동의해요</span></label>${actions(btn('확인'))}</form>`,{back:()=>{draft.memo=$('#memo').value;return regionStep();}});
  form(async f=>{requestWebPushPermission(true);draft.memo=f.get('memo');await api('register',{area:draft.province+' '+draft.district,memo:draft.memo,policy:policyVersion});draft.birthDate='';await boot();});
}
const applePush=window.webkit?.messageHandlers?.paperChatPush;
const androidPush=/PaperChatAndroid\/\d+/.test(globalThis.navigator?.userAgent||'');
let webPermissionPending=false,webAutoPrompted=false,webGesturePrompted=false,webPushSync=null,nextWebPushSync=0;
function supportsWebPush(){
  return !admin && !applePush && !androidPush && !/PaperChatIOS\/\d+/.test(navigator.userAgent||'')
    && typeof window.paperChatNativeForeground!=='boolean' && window.isSecureContext===true
    && typeof window.Notification?.requestPermission==='function' && typeof window.PushManager==='function'
    && typeof navigator.serviceWorker?.register==='function';
}
function requestWebPushPermission(gesture=false){
  if(!supportsWebPush() || window.Notification.permission!=='default' || webPermissionPending)return;
  if(gesture?webGesturePrompted:webAutoPrompted)return;
  if(gesture)webGesturePrompted=true;
  webAutoPrompted=true;
  webPermissionPending=true;
  // Request synchronously in the existing login/signup gesture, before HTTP.
  // A browser may use a quiet prompt or require the next actual user gesture.
  try{Promise.resolve(window.Notification.requestPermission()).then(async()=>{
    if(webPushSync)await webPushSync;
    await syncWebPush(true);
  }).catch(()=>{}).finally(()=>{webPermissionPending=false;});}
  catch{webPermissionPending=false;}
}
for(const event of ['click','keydown'])document.addEventListener(event,e=>{
  if(e.isTrusted && stage==='member' && foregroundVisible())requestWebPushPermission(true);
},{capture:true});
async function syncWebPush(force=false){
  if(!supportsWebPush() || stage!=='member' || !foregroundVisible() || leaving || webPushSync || (!force && Date.now()<nextWebPushSync))return;
  const revision=accountRevision,member=currentMemberId();
  const current=()=>revision===accountRevision && member===currentMemberId() && stage==='member' && !leaving;
  nextWebPushSync=Date.now()+180000;
  webPushSync=(async()=>{
    if(window.Notification.permission!=='granted'){
      await api('push/web',{subscription:null});return;
    }
    const config=await api('push/web-config');if(!current())return;
    if(typeof config.publicKey!=='string' || !/^[\w-]{87}$/.test(config.publicKey))throw Error('Web push key');
    const key=Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    await navigator.serviceWorker.register('/web-push-worker.js',{scope:'/',updateViaCache:'none'});
    const registration=await navigator.serviceWorker.ready;if(!current())return;
    let subscription=await registration.pushManager.getSubscription();if(!current())return;
    if(subscription){
      const previous=new Uint8Array(subscription.options?.applicationServerKey||[]);
      if(previous.length!==key.length || previous.some((v,i)=>v!==key[i])){await subscription.unsubscribe();subscription=null;}
    }
    if(!current())return;
    if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    if(current() && window.Notification.permission==='granted')await api('push/web',{subscription:subscription.toJSON()});
  })().catch(()=>{if(current())nextWebPushSync=Date.now()+15000;}).finally(()=>{webPushSync=null;});
  return webPushSync;
}
let nextPushSync=0;
function pushResult(status){
  if(status==='failed' || status==='checking')nextPushSync=Date.now()+15000;
}
async function syncPush(force=false){
  if(!applePush && !androidPush){await syncWebPush(force);return;}
  if(admin || stage!=='member' || !foregroundVisible() || (!applePush && !androidPush) || (!force && Date.now()<nextPushSync))return;
  const revision=accountRevision;
  nextPushSync=Date.now()+180000;
  try{
    if(androidPush){location.href='paperchat://push/sync';return;}
    const result=await applePush.postMessage('sync');
    if(revision!==accountRevision||stage!=='member'||!foregroundVisible())return;
    if(!result.token){pushResult(result.status);return;}
    const binding=await api('push/device',{platform:result.platform,token:result.token});
    pushResult(binding.configured?'ready':'server');
  }catch{pushResult('failed');}
}
window.addEventListener('message',e=>{
  if(androidPush && typeof e.data==='string' && e.data.startsWith('paperchat-push:'))pushResult(e.data.slice('paperchat-push:'.length));
});
function scopeControls(scope){
  const choice=(regional,label)=>`<button type="button" id="scope-${regional?'area':'all'}" aria-pressed="${Boolean(scope.regional)===regional}">${label}</button>`;
  return '<div class="scope-switch" role="group" aria-label="조회 범위">'+choice(false,'전체')+choice(true,'지역별')+'</div>'+
    (scope.regional?picker():'');
}
async function scopedDirectory(key,endpoint,title,mark,renderRows,open,empty,{back,sub,extra='',wireExtra,live=false}={}){
  const scope=scopes[key];
  paint(title,mark,extra+'<section class="paper">'+scopeControls(scope)+'<div class="rule"></div><div id="list" class="rows" aria-live="polite"></div></section>',
    {back,sub,nav:back?'':tabs(key),headerAction:key==='people'?act('openSettings',icon('settings')+'설정','settings-button'):''});
  if(!back)wireTabs();
  if(key==='people')on('#openSettings','click',settings);
  if(wireExtra)wireExtra();
  const current=epoch,list=$('#list');
  const reload=()=>scopedDirectory(key,endpoint,title,mark,renderRows,open,empty,{back,sub,extra,wireExtra,live});
  const change=regional=>{if(Boolean(scope.regional)===regional)return;scope.regional=regional;return reload();};
  on('#scope-all','click',()=>change(false));
  on('#scope-area','click',()=>change(true));
  let request=0,pending=false,directoryItems=[];
  function render(items){
    directoryItems=items;
    list.innerHTML=items.map(renderRows).join('')||'<p class="empty">'+esc(empty(scope.regional))+'</p>';
    rows(items,open);
  }
  async function refresh(fromTimer=false){
    if(fromTimer && pending)return;
    const id=++request;pending=true;
    const query=scope.regional?'?area='+encodeURIComponent(scope.area):'';
    try{
      const items=await api(endpoint+query);
      if(current!==epoch || id!==request)return;
      if(key==='people')items.sort((a,b)=>(Number(b.lastSeen)||0)-(Number(a.lastSeen)||0)||String(a.id).localeCompare(String(b.id)));
      render(items);
    }catch(e){
      if(current!==epoch || id!==request)return;
      list.replaceChildren();
      if(key==='monitor' && e.status===401){adminLogin();return;}
      err(e);
    }finally{if(id===request)pending=false;}
  }
  if(key==='rooms')roomEventHandler=change=>{
    if(current!==epoch)return;
    const known=directoryItems.find(item=>item.id===change.room);
    if(!change.refresh&&known&&Number(change.version)>0&&Number(change.version)<=Number(known.version))return;
    if(change.closed){request++;render(directoryItems.filter(item=>item.id!==change.room));}
    return refresh();
  };
  if(scope.regional){
    regions||=await api('regions');
    if(current!==epoch)return;
    wirePicker(knownArea(scope.area)?scope.area:me?.area||'',()=>{scope.area=areaOf();list.replaceChildren();void refresh();});
    scope.area=areaOf();
  }
  await refresh();
  if(live && current===epoch)activeTimer=setInterval(()=>{if(foregroundVisible())void refresh(true);},4000);
}
function presenceBadge(p){return `<span class="presence-badge ${p.online?'online':''}">${p.online?'접속 중':p.lastSeen?'최근 접속 · '+esc(at(p.lastSeen)):'접속 기록 없음'}</span>`;}
function people(){
  return scopedDirectory('people','people','프로필 목록','book',
    p=>`<button type="button" class="row profile-row" data-id="${esc(p.id)}"><span><strong>${esc(p.nick)}</strong>${presenceBadge(p)}<small>${esc(p.area+' · '+p.year+'년생 · '+p.gender)}</small><span class="profile-memo-label">소개글</span><span class="profile-memo">${esc(p.memo||'아직 작성된 소개글이 없어요.')}</span></span>${icon('arrow')}</button>`,profile,
    regional=>regional?'이 지역에 다른 회원이 아직 없어요.':'아직 표시할 다른 회원이 없어요.',{live:true});
}
function profile(p){
  paint(p.nick,'book',`<article class="paper">${presenceBadge(p)}<p class="sub">${esc(p.year)}년생 · ${esc(p.gender)} · ${esc(p.area)}</p><div class="rule"></div><h2>소개글</h2><p class="memo">${esc(p.memo)}</p>${actions(act('start','대화하기','primary'))}</article>`,{back:people});
  $('#sections').insertAdjacentHTML('beforeend',actions(act('report','프로필 신고'),act('block','사용자 차단','danger')));
  on('#report','click',()=>reportUI({kind:'profile',peer:p.id,profileVersion:p.profileVersion},()=>profile(p)));on('#block','click',()=>blockPeer(p.id,people));
  on('#start','click',async()=>{const r=await api('room',{peer:p.id});await conversation(r.id,p.nick,false,rooms,p.id,p.area,r.version);});
}
function rooms(){
  return scopedDirectory('rooms','rooms','내 대화','chat',r=>row(r.id,r.nick,r.area,r.unread),
    r=>conversation(r.id,r.nick,false,rooms,r.peer,r.area,r.version),
    regional=>regional?'선택한 지역의 회원과 나눈 대화가 없어요.':'프로필을 열고 첫 대화를 시작해 보세요.',{live:true});
}
function settings(){
  paint('내 설정','settings',`<div class="paper"><h2>${esc(me.nick)}</h2><p class="sub">${esc(me.year)}년생 · ${esc(me.gender)} · ${esc(me.area)}</p><div class="rule"></div><h2>소개글</h2><p class="memo">${esc(me.memo)}</p>${actions(act('editProfile','프로필 편집','secondary'))}${actions(act('logout','로그아웃'),act('withdraw','회원탈퇴','danger'))}</div>${menu('privacy','book','개인정보 처리방침','수집하는 정보와 보관·삭제 기준을 확인하세요.')}`,{back:people});
  $('#sections').insertAdjacentHTML('beforeend',actions(act('recovery','개인 복구코드 보기'),act('blocked','차단한 사용자'))+rulesCard(false));
  accountActions();on('#editProfile','click',editProfile);on('#recovery','click',()=>recoveryPage(settings));on('#blocked','click',blockedList);
}
async function editProfile(){
  if(stage!=='member'||!me)return;
  const openingView=epoch,openingRevision=accountRevision;
  const [state,choices]=await Promise.all([api('state'),regions?Promise.resolve(regions):api('regions')]);
  if(openingView!==epoch||openingRevision!==accountRevision)return;
  if(state.stage==='gate'){clearMemberSession('사용자 정보가 없거나 로그인이 종료되었어요. 다시 인증해 주세요.');return;}
  if(state.stage!=='member'){await boot();return;}
  if(!state.profile)throw new Error('프로필을 확인하지 못했어요. 다시 시도해 주세요.');
  me=state.profile;accountState=state;regions=choices;
  const profile=me,editingId=profile.id;
  paint('프로필 편집','pen',`<section class="paper"><h2>기본 정보</h2><dl class="details"><dt>닉네임</dt><dd>${esc(profile.nick)}</dd><dt>출생연도</dt><dd>${esc(profile.year)}년</dd><dt>성별</dt><dd>${esc(profile.gender)}</dd></dl></section><form class="paper"><div class="field">${picker()}</div><div class="field"><label for="memo">당신을 표현해주세요</label><textarea id="memo" name="memo" required maxlength="800" placeholder="나를 소개하는 글을 자유롭게 적어주세요.">${esc(profile.memo)}</textarea></div>${actions(btn('저장'),act('cancelEdit','취소'))}</form>`,{back:settings,sub:'지역과 소개글을 수정할 수 있어요.'});
  const editingView=epoch,editingRevision=accountRevision;
  wirePicker(profile.area,()=>{},true);
  on('#cancelEdit','click',settings);
  form(async f=>{
    const area=areaOf(),memo=String(f.get('memo')??'').trim();
    if(!knownArea(area))throw new Error('지역과 권역을 선택해 주세요.');
    if(!memo||memo.length>800)throw new Error('소개글을 1자 이상 800자 이하로 입력해 주세요.');
    const result=await api('profile',{area,memo});
    if(editingView!==epoch||editingRevision!==accountRevision||stage!=='member')return;
    if(!result.profile||result.profile.id!==editingId)throw new Error('저장된 프로필을 확인하지 못했어요. 다시 시도해 주세요.');
    me=result.profile;accountState={...accountState,profile:me};
    for(const scope of Object.values(scopes))if(scope.area&&!knownArea(scope.area))scope.area='';
    settings();note('프로필을 저장했어요.');
  });
}
async function jpeg(file){
  if(!file || file.size>24*1024*1024)throw new Error('24MB 이하의 사진을 선택해 주세요.');
  const img=new Image(),url=URL.createObjectURL(file);
  try{img.src=url;await img.decode();const factor=Math.min(1,1400/Math.max(img.width,img.height));const c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(img.width*factor));c.height=Math.max(1,Math.round(img.height*factor));const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);
    for(const q of [.82,.65,.45]){const data=c.toDataURL('image/jpeg',q).split(',')[1];if(data.length<=2_000_000)return data;}
    throw new Error('더 작은 사진을 선택해 주세요.');
  }finally{URL.revokeObjectURL(url);}
}
function highlighted(text,query=''){
  text=String(text??'');if(!query)return esc(text);
  const lower=text.toLowerCase(),needle=query.toLowerCase(),starts=[],ends=[],ranges=[];
  let original=0;
  for(const character of text){
    for(let i=0;i<character.toLowerCase().length;i++){starts.push(original);ends.push(original+character.length);}
    original+=character.length;
  }
  let cursor=0,index;
  while((index=lower.indexOf(needle,cursor))!==-1){
    const from=starts[index],to=ends[index+needle.length-1],last=ranges.at(-1);
    if(last&&from<=last[1])last[1]=Math.max(last[1],to);else ranges.push([from,to]);
    cursor=index+needle.length;
  }
  let result='',start=0;
  for(const [from,to] of ranges){result+=esc(text.slice(start,from))+'<mark>'+esc(text.slice(from,to))+'</mark>';start=to;}
  return result+esc(text.slice(start));
}
const contentExpired=expiresAt=>Number.isFinite(expiresAt)&&expiresAt<=Date.now();
function scheduleContentExpiry(deadlines,callback){
  contentExpiryCheck=callback;
  clearTimeout(contentExpiryTimer);contentExpiryTimer=null;
  const next=Math.min(...deadlines.filter(t=>Number.isFinite(t)&&t>Date.now()));
  if(Number.isFinite(next))contentExpiryTimer=setTimeout(callback,Math.max(1,Math.min(2147483647,next-Date.now())));
}

function message(m,isAdmin,query='',participants=[]){
  if(contentExpired(m.expiresAt))return '';
  if(!isAdmin&&(m.deleted||m.visibility==='deleted'))return '';
  const when=new Date(m.sent).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const labels={pending:'사진 검토 중',reported:'신고 접수 · 검토 중',removed:'이용규칙에 따라 삭제되었어요.',expired:'보관 기간이 지난 사진이에요.'};
  const deleted=isAdmin&&m.deleted,photoVisible=m.viewable&&m.expires>Date.now();
  const body=m.visibility==='removed'?labels.removed:deleted?(m.expires?(photoVisible?`<img draggable="false" alt="삭제된 사진 원본" src="/api/admin/photos/${m.id}">`:labels.expired):highlighted(m.body,isAdmin?query:'')):
    labels[m.visibility]||(m.expires?(photoVisible?`<img draggable="false" alt="대화 사진" src="/api/${isAdmin?'admin/':''}photos/${m.id}">`:'보관 기간이 지난 사진이에요.'):highlighted(m.body,isAdmin?query:''));
  const mine=!isAdmin&&m.author===me?.id;
  const side=isAdmin?(m.author===participants[0]?.id?'left':m.author===participants[1]?.id?'right':''):'';
  const sender=(side?(side==='left'?'왼쪽':'오른쪽')+' · ':'')+m.nick;
  return `<article class="msg ${mine?'mine':''}${isAdmin?' admin-msg':''}${side?' admin-'+side:''}" data-message="${m.id}"><span class="by">${esc(sender)}</span>${deleted?`<span class="deleted-label" title="삭제 · ${esc(at(m.deletedAt))}">${m.expires?'삭제된 사진':'삭제된 채팅'}</span>`:''}<div class="bubble msgText">${body}</div><time class="time">${esc(when)}</time>${mine?`<button type="button" class="textBtn danger" data-delete-message="${m.id}">${m.expires?'사진':'메시지'} 삭제</button>`:''}</article>`;
}
function wireChatEnter(composer){
  if(nativeClient || !composer)return;
  let composing=false;
  composer.addEventListener('compositionstart',()=>{composing=true;});
  composer.addEventListener('compositionend',()=>{composing=false;});
  composer.addEventListener('keydown',event=>{
    if(event.key!=='Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
      || composing || event.isComposing || event.keyCode===229)return;
    event.preventDefault();
    const form=composer.form,submit=form?.querySelector('[type=submit]');
    if(event.repeat || !composer.value.trim() || !submit || submit.disabled)return;
    form.requestSubmit(submit);
  });
}
function followChatLayout(log,composer,current,onVisible){
  let following=true,frame=null,disposed=false,height=log.clientHeight;
  const schedule=window.requestAnimationFrame?.bind(window)||(fn=>{fn();return null;});
  const alive=()=>!disposed && current();
  function resize(){
    if(!alive() || frame!==null)return;
    frame=schedule(()=>{
      frame=null;if(!alive())return;
      height=log.clientHeight;
      if(following && height>0)log.scrollTop=log.scrollHeight;
      if(height>0)onVisible();
    });
  }
  function bottom(){following=true;resize();}
  log.addEventListener('scroll',()=>{
    if(!alive())return;
    // Resizing can itself dispatch scroll. Keep the previous anchor until the
    // new layout settles instead of mistaking a shorter viewport for scrolling up.
    if(frame!==null || height!==log.clientHeight){resize();return;}
    following=log.scrollHeight-log.scrollTop-log.clientHeight<=40;
    if(log.clientHeight>0)onVisible();
  });
  log.addEventListener('load',resize,true);
  // An intentional history scroll takes precedence over a queued keyboard frame.
  log.addEventListener('wheel',event=>{if(alive() && event.deltaY<0)following=false;},{passive:true});
  log.addEventListener('touchmove',()=>{if(alive())following=false;},{passive:true});
  composer?.addEventListener('focus',bottom);
  const observer=typeof window.ResizeObserver==='function'?new window.ResizeObserver(resize):null;
  observer?.observe(log);
  return {resize,bottom,following:()=>following,dispose(){disposed=true;observer?.disconnect();if(frame!==null)window.cancelAnimationFrame?.(frame);frame=null;}};
}
function chatProfile(p){
  if(document.querySelector('dialog[open]'))return;
  const d=document.createElement('dialog');d.className='dialog peer-profile-dialog';d.setAttribute('aria-labelledby','chat-profile-heading');
  d.innerHTML=`<header class="peer-profile-header"><h2 id="chat-profile-heading">${esc(p.nick)}</h2>${act('chat-profile-close','닫기')}</header>
    <div class="peer-profile-body" tabindex="0">${presenceBadge(p)}<p class="sub">${esc(p.year)}년생 · ${esc(p.gender)} · ${esc(p.area)}</p><div class="rule"></div><h3>소개글</h3><p class="memo">${esc(p.memo||'아직 작성된 소개글이 없어요.')}</p></div>`;
  d.onclose=()=>d.remove();main.append(d);d.querySelector('#chat-profile-close').onclick=()=>d.close();d.showModal();
}
function getNewsUI(){
  if(!newsUI)newsUI=createNewsUI({
    document,window,api,paint,tabs,wireTabs,getEpoch:()=>epoch,getMe:()=>me,foregroundVisible,
    scope:scopes.news,adminScope:scopes.adminNews,getRegions:async()=>regions||=await api('regions'),
    picker,wirePicker,areaOf,knownArea,esc,icon,modal,note,err,jpeg,reasons,scheduleExpiry:scheduleContentExpiry,
    openProfile:async id=>{const p=id===me?.id?me:await api('people/'+encodeURIComponent(id));chatProfile(p);},
    openMember:memberDetail,adminBack:monitor
  });
  return newsUI;
}
function news(){return getNewsUI().feed();}
function monitorNews(){return getNewsUI().adminFeed();}
async function conversation(id,title,isAdmin,back,peer,area='',initialVersion=null,searchQuery=''){
  let participants=[];
  if(isAdmin){
    try{participants=(await api('admin/rooms/'+encodeURIComponent(id))).participants;}
    catch(e){
      if(e.stale)return;
      if(e.status===401){adminLogin();return;}
      if(e.status===404){await back();note('대화가 삭제되어 목록으로 돌아왔어요.');return;}
      throw e;
    }
  }
  const query=isAdmin?String(searchQuery).trim():'';
  const endpoint=(isAdmin?'admin/':'')+'rooms/'+encodeURIComponent(id)+'/messages';
  const messagePath=before=>endpoint+((query||before)?'?'+new URLSearchParams({...query?{q:query}:{},...before?{before}: {}}).toString():'');
  const composer=`<form class="compose paper"><label class="sr-only" for="body">메시지</label><textarea id="body" name="body" maxlength="2000" rows="1" placeholder="전하고 싶은 말을 적어주세요."></textarea><input hidden class="off" id="photo" type="file" accept="image/*">${actions(act('attach',icon('photo')+'사진','secondary'),btn('보내기'))}</form>`;
  const participantCards=isAdmin?`<section class="monitor-participants" aria-label="대화 참여자">${participants.map((p,index)=>`<button type="button" id="adminParticipant${index}" class="monitor-participant participant-${index?'right':'left'}"><span class="participant-side">${index?'오른쪽':'왼쪽'} 대화</span><strong>${esc(p.nick)}</strong><small>${esc(p.year+'년생 · '+p.gender+' · '+p.area)}</small><span class="participant-profile-link">프로필 보기 ${icon('arrow')}</span></button>`).join('')}</section>`:'';
  paint(isAdmin?'대화 내용':title,'chat',`${participantCards}${isAdmin?monitorSearch(query,'이 대화 내용 검색','roomSearch'):''}<div class="chat-tools">${act('older',query?'이전 검색 결과':'이전 메시지','textBtn')}${isAdmin?'':act('block','상대 차단','textBtn danger')+act('leaveRoom','채팅 나가기','textBtn danger')}</div><div class="log" id="log"></div>${isAdmin?'':composer}`,{back,sub:isAdmin?'참여자를 누르면 프로필을 볼 수 있어요.':[area,'사진과 글은 전송 후 24시간 뒤 삭제돼요.'].filter(Boolean).join(' · ')});
  main.className='chat-screen'+(isAdmin?' admin-chat-screen':'');fitViewport();
  if(isAdmin){
    participants.forEach((p,index)=>on('#adminParticipant'+index,'click',()=>chatProfile(p)));
    form(async f=>{await conversation(id,title,true,back,peer,area,null,String(f.get('query')??'').trim());});
    on('#clearSearch','click',()=>conversation(id,title,true,back,peer,area));
  }
  if(!isAdmin){
    on('#block','click',()=>blockPeer(peer,()=>returnToRooms()));
    on('#leaveRoom','click',()=>modal('채팅 나가기','나와 상대방의 채팅방이 모두 삭제돼요. 사진과 글은 전송 후 24시간에 삭제돼요.','나가기',async()=>{
      await roomRequest('rooms/'+encodeURIComponent(id)+'/leave',{confirm:true});
      await returnToRooms('채팅방에서 나왔어요.');
    }));
    on('#log','click',e=>{
      const deletion=e.target.closest('[data-delete-message]');if(deletion){
        const messageId=Number(deletion.dataset.deleteMessage),m=items.get(messageId);
        if(!m||m.author!==me?.id)return;
        modal(m.expires?'사진 삭제':'메시지 삭제','양쪽 대화에서 사라져요. 사진과 글은 전송 후 24시간에 삭제돼요.','삭제하기',async()=>{
          await api('messages/'+messageId+'/delete',{confirm:true});
          if(v!==epoch)return;
          removeMessage(messageId);
          note('삭제했어요.');void syncUnread();
        });
      }
    });
  }
  let roomVersion=initialVersion,lastEventVersion=Number(initialVersion)||0;
  const v=epoch,log=$('#log'),deletedLocally=new Set();let items=new Map(),renderedMessages=new Map(),signature='',busy=false,refreshQueued=false,more=true,readThrough=0,reading=false,oldestCursor=null,loaded=false,renderedOnce=false,closing=false;
  const layout=chatLayout=followChatLayout(log,isAdmin?null:$('#body'),()=>v===epoch&&!closing,()=>void markRead());
  if(!isAdmin && peer){
    $('.hero').insertAdjacentHTML('beforeend','<div class="chat-peer-actions">'+act('peerProfile','상대 프로필','peer-profile-button')+act('reportConversation','신고하기','peer-profile-button danger')+'</div>');
    $('.hero').classList.add('has-peer-profile');
    on('#peerProfile','click',async()=>{const p=await roomRequest('people/'+encodeURIComponent(peer));if(v===epoch&&!closing)chatProfile(p);});
    on('#reportConversation','click',()=>conversationReport(id,refresh));
  }
  function removeMessage(messageId){
    deletedLocally.add(messageId);items.delete(messageId);renderedMessages.delete(messageId);signature='';
    log.querySelector(`[data-message="${messageId}"]`)?.remove();
    if(!renderedMessages.size)log.innerHTML='<p class="empty">'+(query?'검색한 내용이 없어요.':'아직 대화가 없어요.')+'</p>';
  }
  if(!isAdmin)roomEventHandler=change=>{
    if(v!==epoch||closing)return;
    if(change.refresh)return refresh();
    if(change.room!==id)return;
    const version=Number(change.version)||0;
    if(version&&version<=Math.max(Number(roomVersion)||0,lastEventVersion))return;
    lastEventVersion=Math.max(lastEventVersion,version);
    if(change.closed)return returnToRooms('종료된 채팅방이에요. 내 대화로 돌아왔어요.');
    if(Number.isSafeInteger(change.deletedMessage)&&change.deletedMessage>0)removeMessage(change.deletedMessage);
    return refresh();
  };
  async function returnToRooms(message=''){
    if(v!==epoch||closing)return;
    closing=true;clearInterval(activeTimer);items.clear();log.replaceChildren();
    $('#body').value='';$('#photo').value='';document.querySelector('dialog[open]')?.close();
    await rooms();
    if(stage==='member'){if(message)note(message);void syncUnread();}
  }
  async function roomRequest(path,body){
    try{return await api(path,body);}catch(e){
      if(!isAdmin&&[404,410].includes(e.status)&&v===epoch){
        await returnToRooms('종료된 채팅방이에요. 내 대화로 돌아왔어요.');
        throw staleRequest();
      }
      throw e;
    }
  }
  const messageSignature=m=>[m.id,m.visibility,m.nick,m.deleted,m.deletedAt,m.expiresAt,(m.expires&&(!m.viewable||m.expires<=Date.now()))?1:0].join(':');
  const orderedMessages=()=>[...items.values()].sort((a,b)=>a.id-b.id);
  function expireLoadedMessages(){
    if(v!==epoch||closing)return;
    let changed=false;const atEnd=layout.following();
    for(const [id,m] of items)if(contentExpired(m.expiresAt))items.delete(id);
    // A history refresh can replace items while awaiting older pages. Keep the
    // displayed rows' deadlines independently, so slow requests cannot extend them.
    for(const [id,m] of renderedMessages)if(contentExpired(m.expiresAt)){
      renderedMessages.delete(id);log.querySelector(`[data-message="${id}"]`)?.remove();changed=true;
    }
    if(changed){
      signature=[...renderedMessages.values()].map(m=>m.signature).join(',');
      if(!renderedMessages.size)log.innerHTML='<p class="empty">'+(query?'검색한 내용이 없어요.':'아직 대화가 없어요.')+'</p>';
      if(atEnd)layout.bottom();
    }
    scheduleContentExpiry([...items.values(),...renderedMessages.values()].map(m=>m.expiresAt),expireLoadedMessages);
  }
  const merge=messages=>{for(const m of messages){oldestCursor=oldestCursor===null?m.id:Math.min(oldestCursor,m.id);if(contentExpired(m.expiresAt)||(!isAdmin&&(m.deleted||m.visibility==='deleted'||deletedLocally.has(m.id))))items.delete(m.id);else items.set(m.id,m);}};
  async function markRead(){
    if(isAdmin||!foregroundVisible()||document.querySelector('dialog[open]')||v!==epoch||reading||log.clientHeight<=0||log.scrollHeight-log.scrollTop-log.clientHeight>40)return;
    const through=Math.max(0,...[...items.values()].filter(m=>!contentExpired(m.expiresAt)&&!m.deleted&&!['reported','removed','pending','expired','deleted'].includes(m.visibility)).map(m=>m.id));
    if(through<=readThrough)return;
    reading=true;
    try{await roomRequest('rooms/'+encodeURIComponent(id)+'/read',{through});readThrough=through;await syncUnread();}
    catch{/* Retry after the next visible refresh. */}finally{reading=false;}
  }
  async function refresh(earlier=false){
    if(v!==epoch)return;if(busy){if(!earlier)refreshQueued=true;return;}busy=true;
    try {
      let ids=[...items.keys()];const before=earlier?oldestCursor:null;
      const data=await roomRequest(messagePath(before));
      if(v!==epoch)return;
      const firstLoad=!renderedOnce,previousOldest=oldestCursor,versionChanged=roomVersion!==null&&roomVersion!==data.roomVersion;
      if(versionChanged){
        if(earlier){busy=false;return await refresh();}
        items.clear();ids=[];oldestCursor=null;loaded=false;
      }
      roomVersion=data.roomVersion;
      const atEnd=layout.following(),height=log.scrollHeight;
      if(earlier||!loaded)more=data.length===60;
      loaded=true;
      merge(data);
      // Revalidate the already-loaded history after moderation or expiry while
      // retaining unchanged DOM nodes below, so reading selections survive.
      if(versionChanged&&previousOldest!==null&&data.length===60){
        let cursor=data[0].id;
        while(cursor>previousOldest){
          const page=await roomRequest(messagePath(cursor));if(v!==epoch)return;
          merge(page);if(page.length<60){more=false;break;}cursor=page[0].id;
        }
      }
      // A large burst between refreshes can leave gaps. Fill them from the preceding pages.
      if(!earlier && ids.length && data.length===60 && data[0].id>Math.max(...ids)){
        let cursor=data[0].id;
        while(cursor>Math.max(...ids)){
          const page=await roomRequest(messagePath(cursor));if(v!==epoch)return;
          merge(page);
          if(page.length<60)break;cursor=page[0].id;
        }
      }
      for(const [id,m] of items)if(contentExpired(m.expiresAt))items.delete(id);
      const ordered=orderedMessages(),next=ordered.map(messageSignature).join(',');
      if(next!==signature || !ordered.length){
        const onlyRemovals=renderedOnce&&ordered.every(m=>renderedMessages.get(m.id)?.signature===messageSignature(m));
        if(onlyRemovals){
          for(const id of renderedMessages.keys())if(!items.has(id))log.querySelector(`[data-message="${id}"]`)?.remove();
          if(!ordered.length)log.innerHTML='<p class="empty">'+(query?'검색한 내용이 없어요.':'아직 대화가 없어요.')+'</p>';
        }else log.innerHTML=ordered.map(m=>message(m,isAdmin,query,participants)).join('')||'<p class="empty">'+(query?'검색한 내용이 없어요.':'아직 대화가 없어요.')+'</p>';
        signature=next;renderedMessages=new Map(ordered.map(m=>[m.id,{signature:messageSignature(m),expiresAt:m.expiresAt}]));renderedOnce=true;
        if(earlier)log.scrollTop+=log.scrollHeight-height;else if(atEnd||firstLoad)layout.bottom();
      }
      scheduleContentExpiry(ordered.map(m=>m.expiresAt),expireLoadedMessages);
      $('#older').hidden=!more;$('#older').classList.toggle('off',!more);
      await markRead();
    }catch(e){if(e.stale)return;if(v===epoch && [401,403,404].includes(e.status)){items.clear();log.replaceChildren();clearInterval(activeTimer);if(!isAdmin){$('#body').value='';void pulse(true);}else if(e.status===401)adminLogin();else if(e.status===404){await back();note('대화가 삭제되어 목록으로 돌아왔어요.');return;}}throw e;}
    finally{busy=false;if(refreshQueued&&v===epoch){refreshQueued=false;void refresh().catch(err);}}
  }
  on('#older','click',()=>refresh(true));
  if(!isAdmin){
    form(async f=>{
      const input=$('#body'),draft=input.value,body=String(f.get('body')).trim();
      if(!body)throw new Error('메시지를 입력해 주세요.');
      await roomRequest(endpoint,{body});
      if(input.value===draft)input.value='';
      await refresh();
    });
    wireChatEnter($('#body'));
    on('#attach','click',()=>$('#photo').click());on('#photo','change',async e=>{
      const f=e.target.files[0];e.target.value='';if(!f)return;const button=$('#attach');button.disabled=true;
      try{const photo=await jpeg(f);if(v!==epoch)return;await roomRequest(endpoint,{photo});note('사진을 보냈어요. 전송 후 24시간 뒤 삭제돼요.');await refresh();}finally{button.disabled=false;}
    });
  }
  await refresh();if(v===epoch)activeTimer=setInterval(()=>{if(foregroundVisible())refresh().catch(err);},2500);
}
const at=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'기록 없음';
let adminPrivate=false,memberDirectoryRequest=0;
// Refresh only while the same administrative screen is open. Never keep showing
// a withdrawn member's contact card after the service has removed it.
function watchDirectory(path,initial,render,expiry){
  const view=epoch,previous=JSON.stringify(initial);
  async function refresh(){
    if(view!==epoch || leaving)return;
    try{
      if(foregroundVisible()&&!document.querySelector('dialog[open]')){
        const current=await api(path);
        if(view!==epoch)return;
        if(!document.querySelector('dialog[open]')&&JSON.stringify(current)!==previous){await render(current);return;}
      }
    }catch(e){
      if(view!==epoch || leaving)return;
      if(e.status===404){await membersPage();return;}
      if(e.status===401){adminLogin();return;}
      veil(true,'서버 연결 후 가입자 정보를 다시 확인해요.');
    }
    if(view===epoch)activeTimer=setTimeout(refresh,4000);
  }
  const delay=expiry?Math.max(20,Math.min(4000,expiry-Date.now()+20)):4000;
  activeTimer=setTimeout(refresh,delay);
}
function deleteMember(m,done){
  modal('회원 삭제',`${m.nick}님을 탈퇴 처리할까요? 계정과 참여한 대화방의 양쪽 메시지·사진이 즉시 삭제돼요. 관리자 대화 기록도 삭제되며, 탈퇴 현황의 닉네임과 탈퇴 시각만 24시간 남아요. 일반 재가입은 24시간 후, 이용 제한 중이면 제한 종료 후 가능해요.`,'회원 삭제',async()=>{
    await api('admin/members/'+encodeURIComponent(m.id)+'/delete',{confirm:true});
    await done();note('탈퇴 처리했어요. 계정과 대화가 삭제되고 탈퇴 현황은 24시간 후 사라져요.');
  });
}
async function membersPage(offset=0,page=null,filter=''){
  const request=++memberDirectoryRequest,scope=scopes.members;
  if(scope.regional){
    regions||=await api('regions');if(request!==memberDirectoryRequest)return;
    if(!knownArea(scope.area)){const region=Object.keys(regions)[0];scope.area=region+' '+regions[region][0];}
  }
  const path='admin/members?offset='+offset+(filter?'&filter='+encodeURIComponent(filter):'')+(scope.regional?'&area='+encodeURIComponent(scope.area):'');
  page??=await api(path);if(request!==memberDirectoryRequest)return;
  const itemLabel=m=>m.status==='withdrawn'?'탈퇴 · '+at(m.expires)+' 삭제 예정':m.area+' · '+(m.online?'접속 중':'최근 접속 '+at(m.lastSeen));
  const reopen=()=>membersPage(offset,null,filter);
  paint(filter==='inactive'?'30일 미접속 회원':'가입자 현황','book',`<section class="paper"><div class="scope-switch" role="group" aria-label="가입자 상태"><button type="button" id="members-all" aria-pressed="${filter!=='inactive'}">전체 현황</button><button type="button" id="members-inactive" aria-pressed="${filter==='inactive'}">30일 미접속자</button></div><div class="rule"></div>${scopeControls(scope)}</section><p class="counts">${scope.regional?esc(scope.area)+' · ':''}가입 중 <strong>${page.counts.active}명</strong> · 30일 미접속 <strong>${page.counts.inactive||0}명</strong>${scope.regional?'':' · 탈퇴 후 24시간 이내 <strong>'+page.counts.withdrawn+'명</strong>'}</p>${scope.regional?'<p class="note">탈퇴 회원은 지역 정보가 남지 않아 전체 목록에서 확인할 수 있어요.</p>':''}<section class="paper"><div class="rows">${page.items.map(m=>`<div class="member-row">${row(m.id,m.nick,itemLabel(m))}${m.status==='withdrawn'?'':`<button type="button" class="textBtn danger" data-delete-member="${esc(m.id)}" aria-label="${esc(m.nick)} 회원 삭제">회원 삭제</button>`}</div>`).join('')||'<p class="empty">해당하는 회원이 없어요.</p>'}</div></section>${actions(offset?act('prevPage','이전 목록'):'',page.more?act('nextPage','다음 목록'):'')}`,{back:adminHome,sub:filter==='inactive'?'마지막 접속 후 30일 이상 지난 회원이에요.':'회원을 선택하면 출생연도, 성별, 지역과 소개글을 볼 수 있어요.'});
  on('#members-all','click',()=>membersPage());on('#members-inactive','click',()=>membersPage(0,null,'inactive'));
  on('#scope-all','click',()=>{scope.regional=false;return membersPage(0,null,filter);});
  on('#scope-area','click',()=>{scope.regional=true;return membersPage(0,null,filter);});
  if(scope.regional)wirePicker(scope.area,()=>{scope.area=areaOf();void membersPage(0,null,filter).catch(err);});
  watchDirectory(path,page,next=>membersPage(offset,next,filter),Math.min(...page.items.filter(i=>i.expires).map(i=>i.expires)));
  rows(page.items,m=>memberDetail(m.id,reopen));
  document.querySelectorAll('[data-delete-member]').forEach(el=>el.onclick=()=>{const m=page.items.find(i=>i.id===el.dataset.deleteMember);if(m)deleteMember(m,reopen);});
  on('#prevPage','click',()=>membersPage(Math.max(0,offset-50),null,filter));on('#nextPage','click',()=>membersPage(offset+50,null,filter));
}
async function memberDetail(id,back,m=null){
  const path='admin/members/'+encodeURIComponent(id);
  m??=await api(path);
  if(m.status==='withdrawn'){
    paint('탈퇴한 회원','book',`<section class="paper"><h2>${esc(m.nick)}</h2><p>탈퇴 · ${esc(at(m.withdrawn))}</p><p>현황에서 삭제 · ${esc(at(m.expires))}</p></section>`,{back});
    watchDirectory(path,m,next=>memberDetail(id,back,next),m.expires);
    return;
  }
  const fields=[['닉네임',m.nick],['출생연도',m.year],['성별',m.gender],['지역',m.area],['소개글',m.memo],['최근 접속',at(m.lastSeen)],['접속 상태',m.online?'접속 중':'접속 종료'],['회원 ID',m.id],['현재 벌점',(m.strikes||0)+' / 3'],['누적 신고 인정',m.totalStrikes||0]];
  if(m.contact)fields.push(['이전 인증 이름',m.contact.name],['이전 인증 전화번호',m.contact.phone],['이전 인증 일시',at(m.verified)]);
  if(m.restrictedUntil)fields.push(['이용 제한 종료',at(m.restrictedUntil)]);
  paint('가입자 상세','book',`<section class="paper"><dl class="details">${fields.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${actions(act('deleteMember','회원 삭제','danger'))}</section>`,{back});
  watchDirectory(path,m,next=>memberDetail(id,back,next));
  on('#deleteMember','click',()=>deleteMember(m,back));
}
async function reviewList(){
  const data=await api('admin/review');
  const reports=data.reports.map(i=>row('r'+i.id,i.nick+' · '+(i.conversationRoom?'대화 · 사진 '+i.photoCount+'장':i.message?'메시지':'프로필'),i.reason+' · '+at(i.created))).join('');
  paint('신고 검토','book',`<section class="letter"><p>사진은 전송 즉시 표시돼요. 신고된 콘텐츠만 검토하며, 신고 인정 3회마다 24시간 이용을 제한해요.</p></section><section class="paper"><h2>접수된 신고</h2><div class="rows">${reports||'접수된 신고가 없어요.'}</div></section>${actions(act('reloadQueue','새로고침'))}`,{back:monitor});
  for(const el of document.querySelectorAll('.row'))el.onclick=()=>{
    const key=el.dataset.id,photo=key.startsWith('p'),id=Number(key.slice(1));
    reviewItem((photo?data.photos:data.reports).find(item=>item.id===id),photo);
  };
  on('#reloadQueue','click',reviewList);
}
function reviewItem(item,isPhoto){
  const picture=isPhoto?item.id:item.photo,conversationPhotos=item.photos||[];
  const excerptDeadline=item.excerptExpiresAt??item.expiresAt,pictureDeadline=item.expiresAt??item.expires;
  if(contentExpired(excerptDeadline))item={...item,excerpt:null};
  const outcome=async action=>{await api('admin/review',{kind:isPhoto?'photo':'report',id:item.id,action});await reviewList();note('검토 결과를 반영했어요.');};
  paint(isPhoto?'사진 검토':item.conversationRoom?'대화 신고 검토':'신고 검토','mail',`<section class="paper"><h2>${esc(item.nick)}</h2><p>${isPhoto||item.message||item.conversationRoom?'보낸 회원':'프로필 작성자'} · ${esc(item.area)}</p>${actions(act('sender','가입자 정보 보기','secondary'),isPhoto?'':act('reporter','신고자 정보 보기'))}<div class="rule"></div><p>${esc(isPhoto?'사진 만료 · '+at(item.expires):item.reason)}</p>${item.excerpt?`<p id="reviewExcerpt" class="memo">${esc(item.excerpt)}</p>`:''}${item.conversationRoom?actions(act('showConversation','신고된 대화 보기','secondary'),conversationPhotos.length?act('showPhotos','신고 사진 '+item.photoCount+'장 확인'): ''):''}${picture?act('showPhoto','검토용 사진 열기'):''}<div id="preview"></div>${isPhoto?actions('<button disabled type="button" id="approve" class="primary">사진 승인</button>',act('deny','사진 거절','danger')):actions(act('dismissReport','신고 거부 · 복원'),act('acceptReport','신고 인정 · 벌점 1점','danger'))}<p class="note">신고를 인정하면 위반 콘텐츠를 삭제하고 작성자에게 벌점 1점을 부여해요. 3점마다 24시간 이용을 제한해요. 같은 콘텐츠에 대한 벌점은 중복 부과하지 않아요.</p></section>`,{back:reviewList});
  const reopen=()=>reviewItem(item,isPhoto);
  on('#showConversation','click',()=>conversation(item.conversationRoom,item.nick+'님의 신고 대화',true,reopen,null,item.area));
  let photosShown=false;
  function renderReviewPhotos(){
    $('#preview').innerHTML='<div class="review-gallery">'+conversationPhotos.map(photo=>`<figure>${photo.viewable&&photo.expires>Date.now()?`<img class="reviewPhoto" src="/api/admin/photos/${photo.id}" alt="${photo.deletedAt?'삭제된 사진 원본':'신고된 사진'}" loading="lazy">`:'<p class="note">사진이 만료되었거나 삭제되었어요.</p>'}<figcaption>${photo.deletedAt?'삭제된 사진 · ':''}사진 ${photo.id} · ${esc(at(photo.expires))} 만료</figcaption></figure>`).join('')+'</div>';
  }
  on('#showPhotos','click',()=>{photosShown=true;renderReviewPhotos();});
  const reviewView=epoch;
  function expireReview(){
    if(reviewView!==epoch)return;
    if(contentExpired(excerptDeadline)){item={...item,excerpt:null};$('#reviewExcerpt')?.remove();}
    if(picture&&contentExpired(pictureDeadline)){
      $('#preview').innerHTML='<p class="note">24시간이 지나 삭제된 사진이에요.</p>';
      const button=$('#showPhoto');if(button)button.disabled=true;
    }
    if(photosShown)renderReviewPhotos();
    scheduleContentExpiry([excerptDeadline,pictureDeadline,...conversationPhotos.map(p=>p.expires)],expireReview);
  }
  expireReview();
  on('#sender','click',()=>memberDetail(item.sender,reopen));on('#reporter','click',()=>memberDetail(item.reporter,reopen));
  on('#showPhoto','click',()=>{
    if(contentExpired(pictureDeadline)){expireReview();return;}
    const button=$('#showPhoto'),img=new Image();button.disabled=true;img.alt='운영자 검토 사진';img.className='reviewPhoto';
    img.onload=()=>{if(reviewView!==epoch)return;if(contentExpired(pictureDeadline)){expireReview();return;}if(isPhoto && $('#approve'))$('#approve').disabled=false;};
    img.onerror=()=>{err(new Error('사진을 열 수 없어요. 보관 기간 또는 처리 상태를 확인해 주세요.'));};
    $('#preview').replaceChildren(img);img.src='/api/admin/photos/'+picture;
  });
  on('#approve','click',()=>outcome('approve'));on('#deny','click',()=>modal('사진 거절','사진을 삭제하고 상대에게 공개하지 않아요.','거절하기',()=>outcome('reject')));
  on('#dismissReport','click',()=>outcome('dismiss'));
  on('#acceptReport','click',()=>modal('신고 인정',item.conversationRoom?(item.photoCount?'이 신고에 포함된 사진을 삭제하고 작성자에게 벌점 1점을 부여할까요?':'신고 당시 메시지를 삭제하고 작성자에게 벌점 1점을 부여할까요?')+' 3점이 되면 24시간 이용을 제한해요.':'위반 콘텐츠를 삭제하고 작성자에게 벌점 1점을 부여할까요? 3점이 되면 24시간 이용을 제한해요.','신고 인정',()=>outcome('accept')));
}
async function adminHome(){
  try{await api('admin/settings');}catch(e){if(e.status===401){adminLogin();return;}throw e;}
  adminPrivate=true;
  paint('운영자 관리실','settings',`<div class="grid adminGrid">${menu('members','book','가입자 현황','전체·지역별·30일 미접속 회원')}${menu('monitor','chat','모니터링','대화·소식과 신고 검토')}${menu('announcements','book','공지설정','일반공지·긴급공지 관리')}${menu('linkSettings','mail','링크관리','인증폼·Android·iPhone 다운로드 주소')}${menu('reset','bin','서버초기화','서비스 데이터 전체 삭제','destructive')}</div>${act('out','관리자 로그아웃','textBtn')}`,{wide:true});
  on('#members','click',()=>membersPage());on('#monitor','click',monitor);on('#announcements','click',adminAnnouncements);on('#linkSettings','click',adminLinkSettings);on('#reset','click',reset);on('#out','click',async()=>{await api('admin/logout',{});adminLogin();});
}
function adminLogin(){
  adminPrivate=false;scopes.monitor={};scopes.members={};memberDirectoryRequest++;
  for(const key of Object.keys(scopes.adminNews))delete scopes.adminNews[key];
  paint('관리자 로그인','key',`<form class="paper">${field('key','관리자 보안키','type="password" autocomplete="current-password" maxlength="256"')}<p class="note">발급 서버에서 승인한 관리자 보안키를 입력해 주세요.</p>${actions(btn('로그인'))}</form>`);
  form(async f=>{await api('admin/login',{key:f.get('key')});await adminHome();});
}
async function adminLinkSettings(){
  const links=await api('admin/link-settings');
  const input=(id,label)=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="url" maxlength="2048" placeholder="https://" value="${esc(links[id])}"></div>`;
  paint('링크관리','mail',`<form class="paper"><h2>인증폼</h2>${input('url','발급 신청서 URL')}<p class="note">회원이 인증키 발급을 신청할 주소예요.</p><div class="rule"></div><h2>앱 다운로드</h2>${input('androidUrl','Android 앱 다운로드 URL')}${input('iosUrl','iPhone 앱 다운로드 URL')}<p class="note">https:// 링크를 입력해 주세요. 다운로드 주소를 비워두면 ‘아직 개발 진행중이에요.’라고 안내해요. 다운로드 주소는 로그인 화면과 공지에 함께 적용됩니다.</p>${actions(btn('링크 저장'))}</form>`,{back:adminHome});
  form(async f=>{
    const values=Object.fromEntries(['url','androidUrl','iosUrl'].map(key=>[key,downloadURL(String(f.get(key)??''))]));
    const saved=await api('admin/link-settings',values);
    for(const key of ['url','androidUrl','iosUrl'])$('#'+key).value=saved[key];note('링크를 저장했어요.');
  });
}
function adminAnnouncements(){
  paint('공지설정','book',`<div class="grid">${menu('announcement','book','일반공지','내용·다운로드 버튼·4시간 숨김')}${menu('urgentAnnouncement','mail','긴급공지','접속 중 즉시 표시·닫기만 제공')}</div>`,{back:adminHome});
  on('#announcement','click',adminAnnouncement);on('#urgentAnnouncement','click',adminUrgentAnnouncement);
}

async function adminAnnouncement(){
  const data=await api('admin/announcement');
  const toggle=(id,title)=>`<label class="check"><input id="${id}" name="${id}" type="checkbox" ${data[id]?'checked':''}><span>${title}</span></label>`;
  const input=(id,title)=>`<div class="field"><label for="${id}">${title}</label><input id="${id}" name="${id}" type="url" maxlength="2048" placeholder="https://" value="${esc(data[id])}"></div>`;
  paint('일반 공지 설정','book',`<form class="paper">${toggle('enabled','일반 공지 표시')}
    <div class="field"><label for="announcementTitle">공지 제목</label><input id="announcementTitle" name="title" maxlength="120" value="${esc(data.title)}"></div>
    <div class="field"><label for="announcementBody">공지 내용</label><textarea id="announcementBody" name="body" maxlength="20000" rows="8" placeholder="회원에게 안내할 내용을 입력해 주세요.">${esc(data.body)}</textarea></div>
    <p class="note">로그인 완료 후 가운데 정렬된 공지가 표시돼요. 긴 내용은 스크롤할 수 있으며, ‘4시간 보지않기’는 해당 브라우저에 적용돼요.</p><div class="rule"></div>
    ${toggle('androidEnabled','공지에 안드로이드앱 버튼 표시')}${input('androidUrl','안드로이드앱 다운로드 URL')}<div class="rule"></div>
    ${toggle('iosEnabled','공지에 아이폰앱 버튼 표시')}${input('iosUrl','아이폰앱 다운로드 URL')}
    <p class="note">켜기·끄기는 공지 안의 버튼에만 적용돼요. 앱에서는 설정에 관계없이 다운로드 버튼을 표시하지 않아요. 다운로드 주소는 로그인 화면과 함께 사용해요. 주소를 비워두면 ‘아직 개발 진행중이에요.’라고 안내해요. 저장한 공지는 다음 로그인 또는 로그인 상태에서 새로고침할 때 반영됩니다.</p>${actions(btn('공지 저장'))}</form>`,{back:adminAnnouncements});
  form(async f=>{
    const values={enabled:f.get('enabled')==='on',title:String(f.get('title')??'').trim(),body:String(f.get('body')??'').trim(),
      androidEnabled:f.get('androidEnabled')==='on',iosEnabled:f.get('iosEnabled')==='on',
      androidUrl:downloadURL(String(f.get('androidUrl')??'')),iosUrl:downloadURL(String(f.get('iosUrl')??''))};
    if(values.enabled && (!values.title || !values.body))throw new Error('공지를 표시하려면 제목과 내용을 입력해 주세요.');
    const saved=await api('admin/announcement',values);
    $('#announcementTitle').value=saved.title;$('#announcementBody').value=saved.body;
    $('#androidUrl').value=saved.androidUrl;$('#iosUrl').value=saved.iosUrl;note('공지를 저장했어요.');
  });
}
async function adminUrgentAnnouncement(){
  const data=await api('admin/urgent-announcement');
  paint('긴급공지 설정','mail',`<form class="paper">
    <label class="check"><input type="checkbox" id="urgentEnabled" name="enabled" ${data.enabled?'checked':''}><span>긴급공지 게시</span></label>
    <div class="field"><label for="urgentTitle">긴급공지 제목</label><input id="urgentTitle" name="title" maxlength="120" value="${esc(data.title)}"></div>
    <div class="field"><label for="urgentBody">긴급공지 내용</label><textarea id="urgentBody" name="body" maxlength="20000" rows="8">${esc(data.body)}</textarea></div>
    <p class="note">켜고 저장하면 접속 중인 회원에게 즉시 표시돼요. 미접속 회원은 다음 로그인 때 일반 공지보다 먼저 확인해요. 긴급공지에는 ‘닫기’만 표시되며, 일반 공지의 4시간 숨김은 적용되지 않아요.</p>
    <p class="note">같은 내용이라도 다시 게시하면 새 긴급공지로 표시돼요. 게시를 끄고 저장하면 공지가 중단됩니다. 게시 중에는 다음 로그인이나 새로고침 때 다시 표시돼요.</p>
    <p class="note" id="urgentPublished">${data.publishedAt?'마지막 게시 · '+esc(at(data.publishedAt)):'아직 게시된 긴급공지가 없어요.'}</p>
    ${actions(btn('긴급공지 저장·적용'))}</form>`,{back:adminAnnouncements});
  form(async f=>{
    const enabled=f.get('enabled')==='on',title=String(f.get('title')??'').trim(),body=String(f.get('body')??'').trim();
    if(enabled && (!title || !body))throw new Error('긴급공지를 게시하려면 제목과 내용을 입력해 주세요.');
    const saved=await api('admin/urgent-announcement',{enabled,title,body});
    $('#urgentTitle').value=saved.title;$('#urgentBody').value=saved.body;
    $('#urgentPublished').textContent=saved.publishedAt?'마지막 게시 · '+at(saved.publishedAt):'긴급공지 게시가 중단됐어요.';
    note(saved.enabled?'긴급공지를 게시했어요.':'긴급공지 게시를 중단했어요.');
  });
}
function monitorSearch(query,label='닉네임 또는 대화 내용 검색',id='monitorSearch'){
  return `<form class="monitor-search" role="search"><label for="${id}">${esc(label)}</label><div class="search-controls"><input id="${id}" name="query" type="search" maxlength="200" value="${esc(query)}" placeholder="검색어를 입력해 주세요." autocomplete="off">${btn('검색')}${act('clearSearch','전체 보기')}</div>${query?`<p class="note">‘${esc(query)}’ 검색 결과</p>`:''}</form>`;
}
function monitor(){
  paint('모니터링','chat',`<div class="grid">${menu('monitorChats','chat','대화','프로필별 대화·내용 검색·신고 검토')}${menu('monitorNews','photo','소식','게시 사진·익명 댓글·삭제 내역·신고 검토')}</div>`,{back:adminHome});
  on('#monitorChats','click',monitorConversations);on('#monitorNews','click',monitorNews);
}
function monitorConversations(){return monitorDirectory();}
function monitorRooms(profile){return monitorDirectory(profile);}
async function monitorDirectory(profile=null){
  const scope=scopes.monitor,query=scope.query||'',isProfileList=!profile;
  const profileHeader=profile?`<section class="paper"><h2>${esc(profile.nick)}${profile.deletedAt?' · 삭제된 회원':''}</h2><p class="sub">${esc(profile.year)}년생 · ${esc(profile.gender)} · ${esc(profile.area)}</p><details class="monitor-intro"><summary>소개글 보기</summary><p class="memo">${esc(profile.memo)}</p></details></section>`:'';
  paint(profile?profile.nick+'님의 대화':'대화 모니터링','chat',
    (isProfileList?actions(act('reviewQueue','사진·신고 검토','secondary')):profileHeader)+
    `<section class="paper">${isProfileList?scopeControls(scope)+'<div class="rule"></div>':''}${monitorSearch(query,isProfileList?'닉네임 또는 대화 내용 검색':'닉네임 또는 이 회원의 대화 내용 검색')}<p id="monitorCount" class="note" aria-live="polite"></p><div id="list" class="rows monitor-list"></div></section>`,
    {back:isProfileList?monitor:monitorConversations,sub:isProfileList?'최근 접속순으로 표시돼요. 프로필을 선택하면 해당 회원의 대화방을 볼 수 있어요.':'대화방을 선택하면 채팅 내용을 볼 수 있어요.'});
  const view=epoch,list=$('#list'),count=$('#monitorCount');let request=0,pending=false,signature='';
  const reopen=()=>monitorDirectory(profile);
  on('#reviewQueue','click',reviewList);
  on('#scope-all','click',()=>{scope.regional=false;return reopen();});
  on('#scope-area','click',()=>{scope.regional=true;return reopen();});
  form(async f=>{scope.query=String(f.get('query')??'').trim();await reopen();});
  on('#clearSearch','click',()=>{scope.query='';return reopen();});
  function profileRow(p){
    const rooms=query?`대화방 ${p.matchedRoomCount}개 일치 / 전체 ${p.roomCount}개`:`대화방 ${p.roomCount}개`;
    return `<button type="button" class="row profile-row monitor-profile" data-id="${esc(p.id)}"><span><strong>${highlighted(p.nick,query)}</strong>${p.deletedAt?'<span class="deleted-label">삭제된 회원</span>':''}<small>${esc(p.area+' · '+p.year+'년생 · '+p.gender)}</small>${presenceBadge(p)}<span class="profile-memo">${esc(p.memo)}</span><span class="room-count">${esc(rooms)}</span><small>${p.recent?'최근 대화 · '+esc(at(p.recent)):'아직 메시지 없음'}</small></span>${icon('arrow')}</button>`;
  }
  function roomRow(r){
    const first=r.firstId===profile.id,nick=first?r.second:r.first,area=first?r.secondArea:r.firstArea,deleted=first?r.secondDeletedAt:r.firstDeletedAt;
    const state=r.closedAt?'종료된 대화 · '+(r.closedReason==='blocked'?'차단':'채팅 나가기'):'대화방';
    return `<button type="button" class="row" data-id="${esc(r.id)}"><span><strong>${highlighted(nick,query)}</strong>${deleted?'<span class="deleted-label">삭제된 회원</span>':''}<small>${esc(area+' · '+state)}</small><small>${esc(r.recent?at(r.recent):'아직 메시지 없음')}</small>${query&&r.matchingMessages?`<span class="room-count">내용 ${r.matchingMessages}개 일치</span><span class="match-snippet">${r.matchDeletedAt?'<span class="deleted-label">삭제된 채팅</span>':''}${highlighted(r.matchSnippet,query)}</span>`:''}</span>${icon('arrow')}</button>`;
  }
  async function refresh(fromTimer=false){
    if(fromTimer&&pending)return;const serial=++request;pending=true;
    const params=new URLSearchParams();if(query)params.set('q',query);
    if(isProfileList&&scope.regional)params.set('area',scope.area);
    if(profile)params.set('member',profile.id);
    const path=(isProfileList?'admin/monitor/profiles':'admin/rooms')+(params.size?'?'+params:'');
    try{
      const items=await api(path);if(view!==epoch||serial!==request)return;
      const next=JSON.stringify(items);if(next===signature)return;signature=next;
      count.textContent=(query?'검색 결과 · ':'')+(isProfileList?'프로필 '+items.length+'명':'대화방 '+items.length+'개');
      list.innerHTML=items.map(isProfileList?profileRow:roomRow).join('')||'<p class="empty">'+(query?'검색 결과가 없어요.':isProfileList?'대화 중인 프로필이 없어요.':'대화방이 없어요.')+'</p>';
      rows(items,isProfileList?monitorRooms:r=>conversation(r.id,r.first+' · '+r.second,true,reopen,null,r.first+' ('+r.firstArea+') · '+r.second+' ('+r.secondArea+')',null,r.matchingMessages?query:''));
    }catch(e){
      if(view!==epoch||serial!==request||e.stale)return;
      if(e.status===401){adminLogin();return;}
      if(profile&&e.status===404){await monitorConversations();note('탈퇴 처리된 회원의 대화는 삭제됐어요.');return;}
      list.replaceChildren();signature='';count.textContent='';err(e);
    }finally{if(serial===request)pending=false;}
  }
  if(isProfileList&&scope.regional){
    regions||=await api('regions');if(view!==epoch)return;
    wirePicker(knownArea(scope.area)?scope.area:'',()=>{scope.area=areaOf();list.replaceChildren();signature='';void refresh();});scope.area=areaOf();
  }
  await refresh();if(view===epoch)activeTimer=setInterval(()=>{if(foregroundVisible())void refresh(true);},4000);
}
function reset(){
  paint('서버 초기화','bin',`<form class="paper"><p>회원, 프로필, 대화, 사진, 소식·익명 댓글·좋아요, 로그인 정보, 탈퇴 후 24시간 현황, 실명·전화번호, 신고·제재·차단·동의 기록과 발급 폼 주소, 앱 다운로드 링크, 공지 설정까지 모두 지워요. 사용자 앱은 다음 연결 때 초기화됩니다.</p>${field('key','로그인한 관리자 보안키','type="password" maxlength="256" autocomplete="current-password"')}${field('confirm','확인을 위해 ‘전체 삭제’ 입력','autocomplete="off"')}${actions(btn('전체 삭제','danger fill'))}</form>`,{back:adminHome});
  form(async f=>{await api('admin/reset',{key:f.get('key'),confirm:f.get('confirm')});note('가입 중 0명 · 탈퇴 현황 0명으로 초기화했어요.');adminLogin();});
}
async function boot(){
  memberViewReady=false;
  const revision=accountRevision,serial=++bootSerial;
  const s=await api('state');if(revision!==accountRevision||serial!==bootSerial)return;
  if(s.stage==='gate'&&hasMemberSession()){clearMemberSession('사용자 정보가 없거나 로그인이 종료되었어요. 다시 인증해 주세요.');return;}
  stage=s.stage;me=s.profile;accountState=s;updatePresence(true);
  if(['policy','restricted'].includes(stage)){limitedPage(stage);return;}
  if(stage==='member'){
    requestWebPushPermission();void syncWebPush(true);
    await syncUnread();
    if(revision!==accountRevision||serial!==bootSerial||stage!=='member')return;
    if(s.needsRecoveryCopy){await recoveryPage();if(revision===accountRevision&&serial===bootSerial){memberViewReady=true;void syncUrgentAnnouncement(true);}return;}
    void syncPush(true);
    const target=new URLSearchParams(location.search),newsId=target.get('news');
    if(newsId!==null&&/^[1-9]\d*$/.test(newsId)&&Number.isSafeInteger(Number(newsId))){
      history.replaceState(null,'',memberPath);await getNewsUI().openPost(Number(newsId));
    }else if(target.get('inbox')==='1'){
      history.replaceState(null,'',memberPath);await rooms();
    }else {if(newsId!==null)history.replaceState(null,'',memberPath);await people();}
    if(revision===accountRevision && serial===bootSerial && stage==='member'){memberViewReady=true;void syncUrgentAnnouncement(true);}
    return;
  }
  if(stage==='details'){Object.assign(draft,{nick:s.nick,gender:s.gender});await regionStep();return;}
  if(stage==='gate_ok'){draft.nick=s.nick||draft.nick;nick();return;}gate();
}
async function start(){
  await api('status');
  if(admin){await adminHome();return;}
  main.innerHTML=`<div class="splash"><div class="stamp">${icon('leaf')}</div><h1>당신은 어떤 사람인가요?</h1></div>`;
  await new Promise(r=>setTimeout(r,matchMedia('(prefers-reduced-motion: reduce)').matches?100:1300));await boot();
}
let pulseTask=null;
function veil(show,message='서버의 계정 상태를 확인하고 있어요.'){
  const cover=$('#lockscreen');
  if(!cover)return;cover.hidden=!show;cover.textContent=message;main.inert=show;
  if(show)closeDialogs();
}
function pulse(protect=false){
  if(leaving||document.hidden||!nativeForeground||!pageForeground)return;
  if(protect)veil(true);
  if(pulseTask)return pulseTask;
  pulseTask=(async()=>{
    try{
      const status=await api('status');
      if(leaving)return;
      const memberId=currentMemberId();
      if(!admin&&memberId&&Object.hasOwn(status,'memberId')&&status.memberId!==memberId){reloadMemberAccount();return;}
      if(!admin && stage==='restricted' && status.stage==='restricted' && status.restrictedUntil!==accountState.restrictedUntil){accountState=status;limitedPage(stage);}
      if(admin && adminPrivate && !status.adminSignedIn){adminLogin();note('관리자 로그인이 종료됐어요.');}
      if(!admin && ['member','restricted','policy'].includes(stage) && status.stage!==stage){
        if(status.stage==='gate'){clearMemberSession('사용자 정보가 없거나 로그인이 종료되었어요. 다시 인증해 주세요.');return;}
        else await boot();
      }
      if(status.stage==='member'){void syncPush(protect);void syncUnread();void syncUrgentAnnouncement(protect);}
      if(foregroundVisible()){contentExpiryCheck?.();veil(false);}
    }catch(e){if(!leaving&&!e.stale)veil(true,'서버에 연결하면 계정 상태를 다시 확인해요.');}
    finally{pulseTask=null;}
  })();
  return pulseTask;
}
setInterval(()=>pulse(),4000);
document.addEventListener('visibilitychange',()=>{updatePresence(true);if(document.hidden)veil(true);else pulse(true);});
window.addEventListener('pagehide',()=>{pageForeground=false;updatePresence(true);veil(true);});
window.addEventListener('pageshow',e=>{pageForeground=true;updatePresence(true);if(e.persisted)pulse(true);});
window.addEventListener('online',()=>{updatePresence(true);pulse(true);});
window.addEventListener('offline',()=>{updatePresence(true);veil(true,'연결이 끊어졌어요. 서버에 다시 연결되면 계속할 수 있어요.');});
start().catch(e=>{if(e.stale)return;paint('연결을 확인해 주세요','mail',actions(act('retry','다시 시도','primary')));err(e);on('#retry','click',()=>location.reload());});
document.addEventListener('contextmenu',e=>{if(e.target.closest('.msg'))e.preventDefault();});

