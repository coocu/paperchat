import {policyVersion,rules,reasons} from './rules.js';
const main=document.querySelector('#app');
const admin=location.pathname==='/admin';
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
let me,regions,stage,activeTimer,epoch=0,selectedArea='';
const draft={nick:'',province:'',district:'',memo:''};
const err=e=>{const el=$('#error');if(el)el.textContent=e.message||String(e);};
const note=msg=>{const el=$('#notice');el.textContent=msg;setTimeout(()=>{if(el.textContent===msg)el.textContent='';},3200);};
async function api(path,body) {
  const controller=path==='status'?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),8000):null;
  let res;
  try{res=await fetch('/api/'+path,{signal:controller?.signal,method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});}finally{if(timer)clearTimeout(timer);}
  const version=res.headers.get('X-Service-Version');
  if(version)recordVersion(version);
  const data=await res.json();
  if(Array.isArray(data))data.roomVersion=res.headers.get('X-Room-Version');
  if(!res.ok){const e=new Error(data.error||'요청에 실패했어요.');e.status=res.status;throw e;}
  return data;
}
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
function paint(title,mark,body,{sub='',back,wide=false,nav=''}={}) {
  clearInterval(activeTimer);epoch++;main.className=wide?'wide':'';
  main.innerHTML=`<header class="bar"><span class="brand">${icon('mail')}종이편지</span>${back?act('back','이전','textBtn'):''}</header><section class="hero"><h1>${icon(mark)}${esc(title)}</h1>${sub?`<p>${esc(sub)}</p>`:''}</section>${nav}${body}${notice}`;
  if(back)on('#back','click',back);
  document.title=title+' · 종이편지';
  window.scrollTo(0,0);
}
function tabs(current){
  return '<nav class="tabs" aria-label="앱 메뉴">'+[['people','프로필 목록'],['rooms','내 대화'],['settings','설정']].map(([id,l])=>act('tab-'+id,l,id===current?'active':'')).join('')+'</nav>';
}
function wireTabs(){on('#tab-people','click',people);on('#tab-rooms','click',rooms);on('#tab-settings','click',settings);}
function row(id,title,subtitle){return `<button type="button" class="row" data-id="${esc(id)}"><span>${esc(title)}<small>${esc(subtitle)}</small></span>${icon('arrow')}</button>`;}
function rows(items,fn){
  document.querySelectorAll('.row').forEach(el=>el.onclick=()=>Promise.resolve(fn(items.find(x=>x.id===el.dataset.id))).catch(err));
}
function menu(id,i,title,desc,extra=''){return `<button id="${id}" class="menu ${extra}"><span class="symbol">${icon(i)}</span><span><strong>${title}</strong><small>${desc}</small></span><span class="chev">${icon('arrow')}</span></button>`;}
function modal(title,desc,label,fn){
  const d=document.createElement('dialog');d.className='dialog';d.innerHTML=`<h2>${esc(title)}</h2><p>${esc(desc)}</p>${actions(act('dismiss','취소'),act('proceed',esc(label),'danger fill'))}`;
  main.append(d);d.showModal();d.onclose=()=>d.remove();
  d.querySelector('#dismiss').onclick=()=>d.close();d.querySelector('#proceed').onclick=async()=>{d.close();try{await fn();}catch(e){err(e);}};
}
const rulesCard=()=>`<aside class="letter"><h2>${icon('book')}이용규칙</h2><ul>${rules.map(r=>'<li>'+esc(r)+'</li>').join('')}</ul></aside>`;
const consentText='본인 확인과 위반 신고 처리를 위해 인증된 이름·휴대폰번호를 수집하며, 관리자만 열람합니다. 가입 완료 전에는 인증 세션 만료 시, 가입 후에는 탈퇴 또는 서버 초기화 시 삭제합니다. 동의를 거부할 수 있으며 거부하면 가입·본인인증 로그인을 진행할 수 없습니다. 탈퇴하면 관리자 현황에 닉네임과 탈퇴·삭제 예정 시각만 24시간 남습니다.';
const resetKey='paperchat.reset';
let leaving=false,knownVersion=localStorage.getItem(resetKey);
function recordVersion(version){
  if(leaving)throw new Error('계정 상태를 갱신하고 있어요.');
  const previous=knownVersion;knownVersion=version;
  localStorage.setItem(resetKey,version);
  if(previous && previous!==version){
    leaving=true;clearInterval(activeTimer);epoch++;me=null;selectedArea='';stage='gate';
    for(const k of Object.keys(draft))draft[k]='';
    sessionStorage.clear();
    main.replaceChildren();location.replace(admin?'/admin?reset=1':'/?reset=1');
    throw new Error('서버가 초기화되어 사용자 정보가 없어요.');
  }
}
function accountActions(){
  on('#logout','click',async()=>{await api('logout',{});location.replace('/');});
  on('#withdraw','click',()=>modal('회원탈퇴','프로필, 실명·연락처와 참여한 대화가 삭제돼요. 관리자 현황에는 닉네임과 탈퇴 시각이 24시간 표시돼요. 일반 재가입은 24시간 후, 이용 제한 중이면 제한 종료 후 가능해요.','탈퇴하기',async()=>{await api('withdraw',{confirm:true});location.replace('/');}));
}
function limitedPage(state){
  const renewal=state==='contact',policy=state==='policy';
  paint(policy?'이용규칙 확인':renewal?'가입 정보 확인':'계정 이용 제한','book',rulesCard()+
    (policy?`<form class="paper"><label class="check"><input required type="checkbox">이용규칙에 동의해요.</label>${actions(btn('확인하고 계속'))}</form>`:renewal?actions(act('renew','휴대폰으로 다시 인증','primary')):'<p>신고 검토 결과에 따라 계정 이용이 제한되었어요.</p>')+
    actions(act('logout','로그아웃'),act('withdraw','회원탈퇴','danger')));
  if(policy)form(async()=>{await api('policy',{version:policyVersion});await boot();});
  if(renewal)on('#renew','click',async()=>{await api('logout',{});location.replace('/');});
  accountActions();
}
function reportUI(target,back){
  paint('신고하기','mail',`<form class="paper"><label for="reason">신고 사유</label><select id="reason" required name="reason"><option value="">선택해 주세요</option>${reasons.map(r=>`<option>${esc(r)}</option>`).join('')}</select><p class="note">담당자가 내용을 확인해요. 신고된 메시지는 검토 중 숨겨집니다.</p>${actions(btn('신고 접수'))}</form>`,{back});
  form(async f=>{await api('report',{...target,reason:f.get('reason')});await back();note('신고를 접수했어요.');});
}
function blockPeer(id,back){
  modal('사용자 차단','서로의 프로필과 대화가 숨겨지고 메시지와 사진을 주고받을 수 없어요.','차단하기',async()=>{await api('blocks',{peer:id});await back();note('사용자를 차단했어요.');});
}
async function blockedList(){
  const items=await api('blocks');
  paint('차단한 사용자','settings',`<div class="paper"><div class="rows">${items.map(i=>row(i.id,i.nick,'차단 해제')).join('')||'차단한 사용자가 없어요.'}</div></div>`,{back:settings});
  rows(items,i=>modal('차단 해제',i.nick+'님의 차단을 해제할까요?','해제하기',async()=>{await api('blocks',{peer:i.id,remove:true});await blockedList();}));
}
function gate(){
  paint('인증키를 입력해 주세요','key',`<form class="paper">${field('code','발급받은 인증키','autocomplete="off" maxlength="256" placeholder="인증키 입력"')}${actions(btn('인증하고 계속'))}</form><aside class="letter"><h2>${icon('mail')}인증키 발급 안내</h2><p>신청서를 작성한 뒤 발급받은 키를 입력해 주세요.</p><div class="rule"></div><a class="btn forest" href="/apply">발급 신청서 열기</a></aside>`);
  main.insertAdjacentHTML('beforeend',rulesCard());
  form(async f=>{await api('key',{code:f.get('code')});nick();});
  if(new URLSearchParams(location.search).has('reset'))err(new Error('서버가 초기화되어 등록된 사용자 정보가 없습니다. 다시 가입해 주세요.'));
  if(new URLSearchParams(location.search).has('form'))err(new Error('등록된 발급 주소가 없어요.'));
}
function nick(){
  paint('어떻게 불러드릴까요?','pen',`<form class="paper">${field('nick','닉네임',`value="${esc(draft.nick)}" maxlength="24" placeholder="대화에서 사용할 이름"`)}${actions(btn('다음'))}</form>${act('existing','이미 가입했어요','textBtn')}`);
  form(f=>{draft.nick=f.get('nick').trim();identity(false);});on('#existing','click',()=>identity(true));
}
let sdk;
function loadSDK(){
  if(window.PortOne)return Promise.resolve();
  if(!sdk)sdk=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.portone.io/v2/browser-sdk.js';s.onload=resolve;s.onerror=()=>{s.remove();sdk=null;reject(new Error('본인인증 화면을 불러오지 못했어요.'));};document.head.append(s);});return sdk;
}
function identity(login){
  paint(login?'다시 만나서 반가워요':'휴대폰 본인인증','key',`<form class="paper"><p>만 19세 생일부터 이용할 수 있어요. 본인 명의의 휴대폰으로 인증해 주세요.</p><div class="rule"></div><p class="note">${esc(consentText)}</p><label class="check"><input type="checkbox" required>이름·전화번호 수집 및 이용에 동의해요.</label>${actions(btn(login?'인증하고 로그인':'통신사 인증하기'))}</form>`,{back:nick});
  form(async()=>{await loadSDK();const request=await api('identity/start',{nick:draft.nick,login,disclosure:policyVersion});const answer=await window.PortOne.requestIdentityVerification(request);
    if(answer?.code)throw new Error(answer.message||'본인인증을 취소했어요.');
    if(answer)await completeIdentity(request.identityVerificationId);
  });
}
async function completeIdentity(id){
  const r=await api('identity/finish',{id});
  if(r.stage==='member')await boot();else regionStep();
}
function picker(){return '<div class="split"><div><label for="province">시·도</label><select id="province"></select></div><div><label for="district">시·군·구</label><select id="district"></select></div></div>';}
function areaOf(){return $('#province').value+' '+$('#district').value;}
function wirePicker(area='',changed=()=>{},requireChoice=false){
  const a=$('#province'),b=$('#district'),provinces=Object.keys(regions);
  if(requireChoice)a.add(new Option('시·도를 선택해 주세요',''));
  for(const x of provinces)a.add(new Option(x,x));
  const region=provinces.find(x=>area.startsWith(x+' '));
  if(region)a.value=region;
  function list(){
    b.replaceChildren();b.disabled=!a.value;
    if(requireChoice)b.add(new Option('시·군·구를 선택해 주세요',''));
    for(const n of regions[a.value]||[])b.add(new Option(n,n));
  }
  list();if(region)b.value=area.slice(region.length+1);
  a.onchange=()=>{list();changed();};b.onchange=changed;
}
async function regionStep(){
  regions||=await api('regions');
  paint('어느 지역에 계세요?','pin',`<form class="paper">${picker()}${actions(btn('다음'))}</form>`,{sub:'프로필에 표시할 시·군·구를 선택해 주세요.'});
  wirePicker(draft.province+' '+draft.district,()=>{},true);
  form(()=>{
    if(!$('#province').value || !$('#district').value)throw new Error('시·도와 시·군·구를 선택해 주세요.');
    draft.province=$('#province').value;draft.district=$('#district').value;memo();
  });
}
function memo(){
  paint('당신의 성향을 알려주세요','leaf',rulesCard()+`<form class="paper"><label for="memo">성향 메모</label><textarea id="memo" name="memo" required maxlength="800" placeholder="나를 소개하는 글을 자유롭게 적어주세요.">${esc(draft.memo)}</textarea><div class="rule"></div><label class="check"><input type="checkbox" required><span>이용규칙에 동의해요. 지역·성향 메모는 회원에게 공개되며, 운영자는 신고 처리와 사진 검토를 위해 대화를 열람할 수 있어요.</span></label>${actions(btn('확인'))}</form>`,{back:()=>{draft.memo=$('#memo').value;return regionStep();}});
  form(async f=>{draft.memo=f.get('memo');await api('register',{area:draft.province+' '+draft.district,memo:draft.memo,policy:policyVersion});await boot();});
}
async function people(){
  regions||=await api('regions');selectedArea||=me.area;
  paint('프로필 목록','book',`<div class="paper">${picker()}<div class="rule"></div><div class="rows" id="list"></div></div>`,{nav:tabs('people')});wireTabs();
  const v=epoch;
  async function refresh(){const area=selectedArea=areaOf();const items=await api('people?area='+encodeURIComponent(area));if(v!==epoch||area!==selectedArea)return;
    $('#list').innerHTML=items.map(p=>row(p.id,p.nick,p.year+'년생 · '+p.gender)).join('')||'<p class="empty">이 지역에 다른 회원이 아직 없어요.</p>';rows(items,profile);}
  wirePicker(selectedArea,()=>refresh().catch(err));await refresh();
}
function profile(p){
  paint(p.nick,'book',`<article class="paper"><p class="sub">${esc(p.year)}년생 · ${esc(p.gender)} · ${esc(p.area)}</p><div class="rule"></div><h2>성향 메모</h2><p class="memo">${esc(p.memo)}</p>${actions(act('start','대화하기','primary'))}</article>`,{back:people});
  main.insertAdjacentHTML('beforeend',actions(act('report','프로필 신고'),act('block','사용자 차단','danger')));
  on('#report','click',()=>reportUI({kind:'profile',peer:p.id},()=>profile(p)));on('#block','click',()=>blockPeer(p.id,people));
  on('#start','click',async()=>{const r=await api('room',{peer:p.id});await conversation(r.id,p.nick,false,rooms,p.id);});
}
async function rooms(){
  paint('내 대화','chat','<section class="paper"><div class="rows" id="list"></div></section>',{nav:tabs('rooms')});wireTabs();const v=epoch;
  async function refresh(){const items=await api('rooms');if(v!==epoch)return;
    $('#list').innerHTML=items.map(r=>row(r.id,r.nick,r.area)).join('')||'<p class="empty">프로필을 열고 첫 대화를 시작해 보세요.</p>';rows(items,r=>conversation(r.id,r.nick,false,rooms,r.peer));}
  await refresh();if(v===epoch)activeTimer=setInterval(()=>refresh().catch(err),4000);
}
function settings(){
  paint('내 설정','settings',`<div class="paper"><h2>${esc(me.nick)}</h2><p class="sub">${esc(me.year)}년생 · ${esc(me.gender)} · ${esc(me.area)}</p><div class="rule"></div><p class="memo">${esc(me.memo)}</p>${actions(act('logout','로그아웃'),act('withdraw','회원탈퇴','danger'))}</div>`,{nav:tabs('settings')});
  main.insertAdjacentHTML('beforeend',actions(act('blocked','차단한 사용자'))+rulesCard());
  wireTabs();accountActions();on('#blocked','click',blockedList);
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
function message(m,isAdmin){
  const when=new Date(m.sent).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const labels={pending:'사진 검토 중',reported:'신고 접수로 숨겨진 메시지예요.',removed:'이용규칙에 따라 삭제되었어요.',expired:'보관 기간이 지난 사진이에요.'};
  const body=labels[m.visibility]||(m.expires?(m.viewable && m.expires>Date.now()?`<img draggable="false" alt="대화 사진" src="/api/${isAdmin?'admin/':''}photos/${m.id}">`:'보관 기간이 지난 사진이에요.'):esc(m.body));
  return `<article class="msg ${!isAdmin&&m.author===me?.id?'mine':''}"><span class="by">${esc(m.nick)}</span><div class="bubble msgText">${body}</div><time class="time">${esc(when)}</time>${!isAdmin&&m.author!==me?.id?`<button type="button" class="textBtn" data-report="${m.id}">신고</button>`:''}</article>`;
}
async function conversation(id,title,isAdmin,back,peer){
  const endpoint=(isAdmin?'admin/':'')+'rooms/'+encodeURIComponent(id)+'/messages';
  const composer=`<form class="compose paper"><label for="body">메시지</label><textarea id="body" name="body" maxlength="2000" rows="2" placeholder="전하고 싶은 말을 적어주세요."></textarea><input hidden class="off" id="photo" type="file" accept="image/*">${actions(act('attach',icon('photo')+'사진 보내기','secondary'),btn('보내기'))}</form>`;
  paint(title,'chat',`${act('older','이전 메시지','textBtn')}<div class="log" id="log"></div>${isAdmin?'':composer}`,{back,sub:isAdmin?'운영자 열람 화면':'사진은 운영자가 승인한 후 표시되며 전송 12시간 뒤 만료돼요.'});
  const reopen=()=>conversation(id,title,isAdmin,back,peer);
  if(!isAdmin){
    main.insertAdjacentHTML('beforeend',actions(act('block','상대 차단','danger')));
    on('#block','click',()=>blockPeer(peer,rooms));
    on('#log','click',e=>{
      const target=e.target.closest('[data-report]');if(target)return reportUI({kind:'message',message:Number(target.dataset.report)},reopen);
    });
  }
  let roomVersion=null;
  const v=epoch,log=$('#log');let items=new Map(),signature='',busy=false,more=true;
  async function refresh(earlier=false){
    if(busy || v!==epoch)return;busy=true;
    try {
      let ids=[...items.keys()];const before=earlier&&ids.length?Math.min(...ids):null;
      const data=await api(endpoint+(before?'?before='+before:''));
      if(v!==epoch)return;
      if(roomVersion!==null && roomVersion!==data.roomVersion){
        items.clear();ids=[];signature='';
        if(earlier){busy=false;return await refresh();}
      }
      roomVersion=data.roomVersion;
      const atEnd=log.scrollHeight-log.scrollTop-log.clientHeight<40,height=log.scrollHeight;
      if(earlier||!ids.length)more=data.length===60;
      for(const m of data)items.set(m.id,m);
      // A large burst between refreshes can leave gaps. Fill them from the preceding pages.
      if(!earlier && ids.length && data.length===60 && data[0].id>Math.max(...ids)){
        let cursor=data[0].id;
        while(cursor>Math.max(...ids)){
          const page=await api(endpoint+'?before='+cursor);if(v!==epoch)return;
          for(const m of page)items.set(m.id,m);
          if(page.length<60)break;cursor=page[0].id;
        }
      }
      const ordered=[...items.values()].sort((a,b)=>a.id-b.id);
      const next=ordered.map(m=>[m.id,m.visibility,m.nick,(m.expires && (m.expires<=Date.now()||!m.viewable))?1:0].join(':')).join(',');
      if(next!==signature || !ordered.length){
        signature=next;log.innerHTML=ordered.map(m=>message(m,isAdmin)).join('')||'<p class="empty">아직 대화가 없어요.</p>';
        if(earlier)log.scrollTop+=log.scrollHeight-height;else if(atEnd||!ids.length)log.scrollTop=log.scrollHeight;
      }
      $('#older').hidden=!more;$('#older').classList.toggle('off',!more);
    }catch(e){if(v===epoch && [401,403,404].includes(e.status)){items.clear();log.replaceChildren();clearInterval(activeTimer);}throw e;}
    finally{busy=false;}
  }
  on('#older','click',()=>refresh(true));
  if(!isAdmin){
    form(async f=>{const body=String(f.get('body')).trim();if(!body)throw new Error('메시지를 입력해 주세요.');await api(endpoint,{body});$('#body').value='';await refresh();});
    on('#attach','click',()=>$('#photo').click());on('#photo','change',async e=>{
      const f=e.target.files[0];e.target.value='';if(!f)return;const button=$('#attach');button.disabled=true;
      try{await api(endpoint,{photo:await jpeg(f)});note('사진을 접수했어요. 운영자가 확인한 뒤 표시돼요.');await refresh();}finally{button.disabled=false;}
    });
  }
  await refresh();if(v===epoch)activeTimer=setInterval(()=>{if(!document.hidden)refresh().catch(err);},2500);
}
const at=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'기록 없음';
let adminPrivate=false;
// Refresh only while the same administrative screen is open. Never keep showing
// a withdrawn member's contact card after the service has removed it.
function watchDirectory(path,initial,render,expiry){
  const view=epoch,previous=JSON.stringify(initial);
  async function refresh(){
    if(view!==epoch || leaving)return;
    try{
      if(!document.hidden){
        const current=await api(path);
        if(view!==epoch)return;
        if(JSON.stringify(current)!==previous){await render(current);return;}
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
async function membersPage(offset=0,page=null){
  const path='admin/members?offset='+offset;
  page??=await api(path);
  const itemLabel=m=>m.status==='withdrawn'?'탈퇴 · '+at(m.expires)+' 삭제 예정':m.area;
  paint('가입자 현황','book',`<p class="counts">가입 중 <strong>${page.counts.active}명</strong> · 탈퇴 후 24시간 이내 <strong>${page.counts.withdrawn}명</strong></p><section class="paper"><div class="rows">${page.items.map(m=>row(m.id,m.nick,itemLabel(m))).join('')||'가입자가 없어요.'}</div></section>${actions(offset?act('prevPage','이전 목록'):'',page.more?act('nextPage','다음 목록'):'')}`,{back:adminHome,sub:'회원을 선택하면 본인인증으로 확인한 이름과 전화번호를 볼 수 있어요.'});
  watchDirectory(path,page,next=>membersPage(offset,next),Math.min(...page.items.filter(i=>i.expires).map(i=>i.expires)));
  rows(page.items,m=>memberDetail(m.id,()=>membersPage(offset)));
  on('#prevPage','click',()=>membersPage(Math.max(0,offset-50)));on('#nextPage','click',()=>membersPage(offset+50));
}
async function memberDetail(id,back,m=null){
  const path='admin/members/'+encodeURIComponent(id);
  m??=await api(path);
  if(m.status==='withdrawn'){
    paint('탈퇴한 회원','book',`<section class="paper"><h2>${esc(m.nick)}</h2><p>탈퇴 · ${esc(at(m.withdrawn))}</p><p>현황에서 삭제 · ${esc(at(m.expires))}</p></section>`,{back});
    watchDirectory(path,m,next=>memberDetail(id,back,next),m.expires);
    return;
  }
  const fields=[['닉네임',m.nick],['인증된 이름',m.contact?.name||'재인증 전'],['인증된 전화번호',m.contact?.phone||'재인증 전'],['인증 확인 일시',at(m.verified)],['지역',m.area],['회원 ID',m.id]];
  if(m.restrictedUntil)fields.push(['이용 제한 종료',at(m.restrictedUntil)]);
  paint('가입자 상세','book',`<section class="paper"><dl class="details">${fields.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`,{back});
  watchDirectory(path,m,next=>memberDetail(id,back,next));
}
async function reviewList(){
  const data=await api('admin/review');
  const photoItems=data.photos.map(i=>row('p'+i.id,i.nick+' · 사진',i.area+' · '+at(i.sent))).join('');
  const reports=data.reports.map(i=>row('r'+i.id,i.nick+' · '+(i.message?'메시지':'프로필'),i.reason+' · '+at(i.created))).join('');
  paint('사진·신고 검토','book',`<section class="paper"><h2>승인 대기 사진</h2><div class="rows">${photoItems||'대기 중인 사진이 없어요.'}</div></section><section class="paper"><h2>접수된 신고</h2><div class="rows">${reports||'접수된 신고가 없어요.'}</div></section>${actions(act('reloadQueue','새로고침'))}`,{back:monitor});
  for(const el of document.querySelectorAll('.row'))el.onclick=()=>{
    const key=el.dataset.id,photo=key.startsWith('p'),id=Number(key.slice(1));
    reviewItem((photo?data.photos:data.reports).find(item=>item.id===id),photo);
  };
  on('#reloadQueue','click',reviewList);
}
function reviewItem(item,isPhoto){
  const picture=isPhoto?item.id:item.photo;
  const outcome=async action=>{await api('admin/review',{kind:isPhoto?'photo':'report',id:item.id,action});await reviewList();note('검토 결과를 반영했어요.');};
  paint(isPhoto?'사진 검토':'신고 검토','mail',`<section class="paper"><h2>${esc(item.nick)}</h2><p>${isPhoto||item.message?'보낸 회원':'프로필 작성자'} · ${esc(item.area)}</p>${act('sender','가입자 정보 보기','secondary')}${isPhoto?'':act('reporter','신고자 정보 보기')}<div class="rule"></div><p>${esc(isPhoto?'사진 만료 · '+at(item.expires):item.reason)}</p>${item.excerpt?`<p class="memo">${esc(item.excerpt)}</p>`:''}${picture?act('showPhoto','검토용 사진 열기'):''}<div id="preview"></div>${isPhoto?actions('<button disabled type="button" id="approve" class="primary">사진 승인</button>',act('deny','사진 거절','danger')):actions(act('dismissReport','위반 없음'),act('remove','콘텐츠 삭제','danger'),act('suspend','삭제 및 30일 이용 제한','danger'))}</section>`,{back:reviewList});
  const reopen=()=>reviewItem(item,isPhoto);
  on('#sender','click',()=>memberDetail(item.sender,reopen));on('#reporter','click',()=>memberDetail(item.reporter,reopen));
  on('#showPhoto','click',()=>{
    const button=$('#showPhoto'),img=new Image();button.disabled=true;img.alt='운영자 검토 사진';img.className='reviewPhoto';
    img.onload=()=>{if(isPhoto && $('#approve'))$('#approve').disabled=false;};
    img.onerror=()=>{err(new Error('사진을 열 수 없어요. 보관 기간 또는 처리 상태를 확인해 주세요.'));};
    $('#preview').replaceChildren(img);img.src='/api/admin/photos/'+picture;
  });
  on('#approve','click',()=>outcome('approve'));on('#deny','click',()=>modal('사진 거절','사진을 삭제하고 상대에게 공개하지 않아요.','거절하기',()=>outcome('reject')));
  on('#dismissReport','click',()=>outcome('dismiss'));
  on('#remove','click',()=>modal('위반 콘텐츠 삭제','신고된 내용을 삭제할까요?','삭제',()=>outcome('remove')));
  on('#suspend','click',()=>modal('30일 이용 제한','신고된 내용을 삭제하고 해당 회원의 활동과 재가입을 30일간 제한할까요?','제한 적용',()=>outcome('suspend')));
}
async function adminHome(){
  try{await api('admin/settings');}catch(e){if(e.status===401){adminLogin();return;}throw e;}
  adminPrivate=true;
  paint('운영자 관리실','settings',`<div class="grid adminGrid">${menu('url','mail','인증폼 주소','발급 신청서 연결') }${menu('monitor','chat','대화 모니터링','지역별 대화 열람')}${menu('members','book','가입자 현황','가입·탈퇴 회원 조회')}${menu('reset','bin','서버 초기화','서비스 데이터 전체 삭제','destructive')}</div>${act('out','관리자 로그아웃','textBtn')}`,{wide:true});
  on('#members','click',()=>membersPage());on('#url','click',adminURL);on('#monitor','click',monitor);on('#reset','click',reset);on('#out','click',async()=>{await api('admin/logout',{});adminLogin();});
}
function adminLogin(){
  adminPrivate=false;
  paint('관리자 로그인','key',`<form class="paper">${field('key','관리자 보안키','type="password" autocomplete="current-password" maxlength="512"')}${actions(btn('로그인'))}</form>`);
  form(async f=>{await api('admin/login',{key:f.get('key')});await adminHome();});
}
async function adminURL(){
  const c=await api('admin/settings');
  paint('인증폼 주소','mail',`<form class="paper">${field('url','발급 신청서 URL',`type="url" placeholder="https://" value="${esc(c.url)}"`)}<p class="note">저장하면 앱의 발급 신청 버튼에 바로 반영돼요.</p>${actions(btn('주소 저장'))}</form>`,{back:adminHome});
  form(async f=>{await api('admin/settings',{url:f.get('url')});note('인증폼 주소를 저장했어요.');});
}
let monitorArea='';
async function monitor(){
  regions||=await api('regions');
  paint('지역별 대화 모니터링','pin',`<section class="paper">${picker()}<div class="rule"></div><h2>대화 목록</h2><div id="list" class="rows"></div></section>`,{back:adminHome,sub:'선택한 지역의 회원이 참여한 대화를 열람해요.'});
  main.insertAdjacentHTML('afterbegin',actions(act('reviewQueue','사진·신고 검토','primary')));on('#reviewQueue','click',reviewList);
  const v=epoch;
  async function refresh(){const area=monitorArea=areaOf(), items=await api('admin/rooms?area='+encodeURIComponent(area));if(v!==epoch||area!==monitorArea)return;
    $('#list').innerHTML=items.map(r=>row(r.id,r.first+' · '+r.second,r.recent?new Date(r.recent).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'새 대화')).join('')||'<p class="empty">이 지역의 대화가 아직 없어요.</p>';
    rows(items,r=>conversation(r.id,r.first+' · '+r.second,true,monitor));}
  wirePicker(monitorArea,()=>refresh().catch(err));await refresh();if(v===epoch)activeTimer=setInterval(()=>refresh().catch(err),4000);
}
function reset(){
  paint('서버 초기화','bin',`<form class="paper"><p>회원, 프로필, 대화, 사진, 로그인 정보, 탈퇴 후 24시간 현황, 실명·전화번호, 신고·제재·차단·동의 기록과 발급 폼 주소까지 모두 지워요. 사용자 앱은 다음 연결 때 초기화됩니다.</p>${field('key','관리자 보안키','type="password" autocomplete="current-password"')}${field('confirm','확인을 위해 ‘전체 삭제’ 입력','autocomplete="off"')}${actions(btn('전체 삭제','danger fill'))}</form>`,{back:adminHome});
  form(async f=>{await api('admin/reset',{key:f.get('key'),confirm:f.get('confirm')});note('가입 중 0명 · 탈퇴 현황 0명으로 초기화했어요.');adminLogin();});
}
async function boot(){
  const s=await api('state');stage=s.stage;me=s.profile;
  if(['policy','restricted','contact'].includes(stage)){limitedPage(stage);return;}
  if(stage==='member'){await people();return;}
  if(stage==='verified'){await regionStep();return;}
  if(stage==='gate_ok'){draft.nick=s.nick||draft.nick;nick();return;}gate();
}
async function start(){
  await api('status');
  if(admin){await adminHome();return;}
  if(location.pathname==='/identity-return'){
    const q=new URLSearchParams(location.search);history.replaceState(null,'','/');
    try{if(q.has('code'))throw new Error('본인인증이 완료되지 않았어요.');await completeIdentity(q.get('identityVerificationId'));}
    catch(e){await boot();err(e);}return;
  }
  main.innerHTML=`<div class="splash"><div class="stamp">${icon('leaf')}</div><h1>당신의 성향을 존중합니다</h1></div>`;
  await new Promise(r=>setTimeout(r,matchMedia('(prefers-reduced-motion: reduce)').matches?100:1300));await boot();
}
let pulseTask=null;
function veil(show,message='서버의 계정 상태를 확인하고 있어요.'){
  const cover=$('#lockscreen');
  if(!cover)return;cover.hidden=!show;cover.textContent=message;main.inert=show;
  if(show){document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
}
function pulse(protect=false){
  if(document.hidden)return;
  if(protect)veil(true);
  if(pulseTask)return pulseTask;
  pulseTask=(async()=>{
    try{
      const status=await api('status');
      if(leaving)return;
      if(admin && adminPrivate && !status.adminSignedIn){adminLogin();note('관리자 로그인이 종료됐어요.');}
      if(!admin && ['member','restricted','policy','contact'].includes(stage) && status.stage!==stage){
        if(status.stage==='gate'){me=null;selectedArea='';await boot();err(new Error('사용자 정보가 없거나 로그인이 종료되었어요. 다시 인증해 주세요.'));}
        else await boot();
      }
      veil(false);
    }catch{if(!leaving)veil(true,'서버에 연결하면 계정 상태를 다시 확인해요.');}
    finally{pulseTask=null;}
  })();
  return pulseTask;
}
setInterval(()=>pulse(),4000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)veil(true);else pulse(true);});
window.addEventListener('pagehide',()=>veil(true));
window.addEventListener('pageshow',e=>{if(e.persisted)pulse(true);});
window.addEventListener('online',()=>pulse(true));
window.addEventListener('offline',()=>veil(true,'연결이 끊어졌어요. 서버에 다시 연결되면 계속할 수 있어요.'));
start().catch(e=>{paint('연결을 확인해 주세요','mail',actions(act('retry','다시 시도','primary')));err(e);on('#retry','click',()=>location.reload());});
document.addEventListener('contextmenu',e=>{if(e.target.closest('.msg'))e.preventDefault();});

