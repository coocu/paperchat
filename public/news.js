// Browser objects and application state are supplied by the host. Importing this
// module does not read document/window or create timers.
export function createNewsUI(deps){
  const {document,window,api,paint,tabs,wireTabs,getEpoch,getMe,foregroundVisible,
    scope,adminScope,getRegions,picker,wirePicker,areaOf,knownArea,esc,icon,
    modal,note,err,jpeg,reasons,openProfile,openMember,adminBack,scheduleExpiry}=deps;
  const $=selector=>document.querySelector(selector);
  const time=value=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const button=(id,label,style='')=>`<button type="button" id="${id}" class="${style}">${label}</button>`;
  const expired=deadline=>!Number.isFinite(deadline)||deadline<=Date.now();
  const deadline=(post,admin)=>admin?post.expiresAt:post.publicUntil;
  let active=null;

  function dispose(){
    if(!active)return;
    if(active.timer!=null)window.clearInterval?.(active.timer);
    active.posts?.clear();for(const entry of active.comments?.values()||[])entry.items.clear();active.comments?.clear();active.reports?.clear();active.pendingLikes?.clear();
    active.report=null;active.mine=null;active.list=null;active=null;
  }
  const alive=state=>active===state&&getEpoch()===state.epoch;
  const canRead=(state,post)=>!expired(deadline(post,state.admin));
  function bind(element,event,fn){
    element?.addEventListener(event,async e=>{
      if(event==='submit')e.preventDefault();
      try{await fn(e);}catch(error){err(error);}
    });
  }
  function begin(admin,kind){
    const state={admin,kind,epoch:getEpoch(),posts:new Map(),comments:new Map(),reports:new Map(),pendingLikes:new Set(),list:$('#news-list'),timer:null,busy:false,queued:false,changeVersion:0,cursor:null,mine:null};
    active=state;
    return state;
  }
  function watch(state){
    state.timer=window.setInterval?.(()=>{
      if(!alive(state)){if(state.timer!=null)window.clearInterval?.(state.timer);return;}
      expire(state);
      if(foregroundVisible())void state.refresh().catch(err);
    },4000);
  }
  function schedule(state){
    if(!alive(state))return;
    const dates=[...state.posts.values()].map(p=>deadline(p,state.admin));
    for(const report of state.reports.values())dates.push(report.expiresAt);
    if(state.report)dates.push(state.report.expiresAt);
    scheduleExpiry(dates,()=>expire(state));
  }
  function expire(state){
    if(!alive(state))return;
    for(const [id,post] of state.posts)if(!canRead(state,post)){
      state.posts.delete(id);state.comments.delete(id);
      state.list?.querySelector(`[data-news-post="${id}"]`)?.remove();
      if(state.mine?.id===id)state.mine=null;
    }
    for(const [id,report] of state.reports)if(expired(report.expiresAt))
      state.reports.set(id,{...report,excerpt:null,viewable:false});
    if(state.kind==='reports')renderReportList(state);
    if(state.kind==='report'&&state.report&&expired(state.report.expiresAt)){
      state.report={...state.report,excerpt:null,viewable:false};
      $('#news-report-evidence')?.replaceChildren();
      const status=$('#news-report-status');if(status)status.textContent='업로드 후 24시간이 지나 원문이 삭제됐어요.';
      const accept=$('#news-report-accept');if(accept)accept.disabled=true;
    }
    if(state.list&&!state.posts.size&&state.kind!=='reports')empty(state);
    schedule(state);
  }
  function empty(state){
    if(!state.list||state.posts.size)return;
    if(!state.list.querySelector('.news-empty'))state.list.innerHTML='<p class="empty news-empty">'+(state.kind==='detail'?'보관 기간이 지났거나 삭제된 소식이에요.':'아직 표시할 소식이 없어요.')+'</p>';
  }
  function filters(selected){
    return `<section class="paper news-scope"><div class="scope-switch" role="group" aria-label="소식 조회 범위"><button type="button" id="news-scope-all" aria-pressed="${!selected.regional}">전국</button><button type="button" id="news-scope-area" aria-pressed="${Boolean(selected.regional)}">지역별</button></div>${selected.regional?picker():''}</section>`;
  }
  async function wireScope(state,selected,reopen){
    bind($('#news-scope-all'),'click',()=>{selected.regional=false;return reopen();});
    bind($('#news-scope-area'),'click',()=>{selected.regional=true;return reopen();});
    if(selected.regional){
      await getRegions();if(!alive(state))return;
      wirePicker(knownArea(selected.area)?selected.area:getMe()?.area||'',()=>{selected.area=areaOf();void reopen().catch(err);});
      selected.area=areaOf();
    }
  }
  function mediaState(post,admin){
    if(expired(deadline(post,admin)))return '보관 기간이 지난 사진이에요.';
    if(admin&&post.viewable)return '';
    if(!admin&&post.visibility==='reported')return '신고 접수 · 사진 검토 중';
    if(post.visibility==='removed')return '이용규칙에 따라 숨겨진 사진이에요.';
    if(!post.viewable)return '현재 표시할 수 없는 사진이에요.';
    return '';
  }
  function statusLabel(post){
    if(post.visibility==='removed')return '신고 인정 · 공개 중단';
    if(post.retiredReason==='deleted')return '삭제된 사진';
    if(post.retiredAt)return '이전 사진 · 공개 중단';
    if(post.publicUntil<=Date.now())return '12시간 공개 종료';
    if(post.visibility==='reported')return '신고 검토 중';
    return '공개 중';
  }
  function card(post,state){
    const node=document.createElement('article');node.className='paper news-card';node.dataset.newsPost=String(post.id);
    node.innerHTML=`<header class="news-card-header"><button type="button" class="textBtn news-author" data-news-action="profile"></button><time class="note" data-news-role="time"></time></header><p class="note news-area" data-news-role="area"></p>${state.admin?'<p class="news-state" data-news-role="state"></p>':''}<div class="news-media" data-news-role="media"></div><div class="news-actions"><button type="button" class="news-like" data-news-action="like" aria-pressed="false"></button><button type="button" data-news-action="comments"></button><button type="button" class="textBtn danger" data-news-action="report">사진 신고</button><button type="button" class="textBtn danger" data-news-action="delete">사진 삭제</button>${state.admin?'<button type="button" class="secondary" data-news-action="detail">상세 보기</button>':''}</div><section class="news-comments" data-news-role="comments" hidden><h3>댓글</h3><p class="note">${state.admin?'댓글 작성자는 운영자에게만 표시돼요.':'댓글에는 닉네임과 프로필이 표시되지 않아요.'}</p><button type="button" class="textBtn" data-news-action="older-comments" hidden>이전 댓글</button><div class="news-comment-list" data-news-role="comment-list"></div>${state.admin?'':`<form class="news-comment-form"><label class="sr-only" for="news-comment-${post.id}">익명 댓글</label><textarea id="news-comment-${post.id}" name="body" maxlength="2000" rows="2" required placeholder="익명으로 댓글을 남겨 보세요."></textarea><button type="submit" class="primary">댓글 보내기</button></form>`}</section>`;
    bind(node,'click',event=>handleCardAction(state,post.id,event));
    bind(node.querySelector('form'),'submit',event=>sendComment(state,post.id,event.currentTarget));
    return node;
  }
  function updateCard(node,post,state){
    const author=node.querySelector('[data-news-action="profile"]');author.textContent=post.author?.nick||'게시자 프로필';author.disabled=!post.author?.id;
    node.querySelector('[data-news-role="time"]').textContent=time(post.created);
    node.querySelector('[data-news-role="area"]').textContent=(post.author?.area||'')+' · '+(state.admin?'원문 삭제 '+time(post.expiresAt):'공개 종료 '+time(post.publicUntil));
    if(state.admin)node.querySelector('[data-news-role="state"]').textContent=statusLabel(post);
    const media=node.querySelector('[data-news-role="media"]'),label=mediaState(post,state.admin);
    if(label){if(media.dataset.label!==label){media.innerHTML='<p class="news-placeholder" role="status">'+esc(label)+'</p>';media.dataset.label=label;}}
    else{
      const src='/api/'+(state.admin?'admin/':'')+'news/'+post.id+'/photo';
      if(!media.querySelector('img')||media.querySelector('img').getAttribute('src')!==src){
        media.innerHTML=`<img src="${src}" alt="${state.admin&&post.retiredAt?'공개가 중단된 소식 사진 원본':'소식 사진'}" draggable="false" loading="lazy">`;media.dataset.label='';
        media.querySelector('img').addEventListener('error',()=>{if(alive(state)&&media.isConnected){media.innerHTML='<p class="news-placeholder">사진을 불러올 수 없어요. 잠시 후 다시 확인해 주세요.</p>';}});
      }
    }
    const like=node.querySelector('[data-news-action="like"]');like.textContent='좋아요 '+Math.max(0,post.likeCount||0);like.setAttribute('aria-pressed',String(Boolean(post.liked)));like.disabled=state.admin||post.visibility!=='visible'||state.pendingLikes.has(post.id);
    const comments=node.querySelector('[data-news-action="comments"]');comments.textContent='댓글 '+Math.max(0,post.commentCount||0);
    comments.disabled=!state.admin&&post.visibility!=='visible';
    node.querySelector('[data-news-action="report"]').hidden=state.admin||post.mine||post.visibility!=='visible';
    node.querySelector('[data-news-action="delete"]').hidden=state.admin||!post.mine;
    if(!state.admin&&post.visibility!=='visible'){
      state.comments.delete(post.id);node.querySelector('[data-news-role="comment-list"]').replaceChildren();
      node.querySelector('[data-news-role="comments"]').hidden=true;
    }
  }
  function renderPosts(state,posts){
    if(!alive(state))return;
    const fresh=new Map(posts.filter(p=>canRead(state,p)).map(p=>[p.id,p]));
    for(const [id] of state.posts)if(!fresh.has(id)){
      state.comments.delete(id);state.list.querySelector(`[data-news-post="${id}"]`)?.remove();
    }
    state.posts=fresh;
    if(fresh.size)state.list.querySelector('.news-empty')?.remove();
    let index=0;
    for(const post of fresh.values()){
      let node=state.list.querySelector(`[data-news-post="${post.id}"]`);if(!node)node=card(post,state);
      updateCard(node,post,state);
      if(state.list.children[index]!==node)state.list.insertBefore(node,state.list.children[index]||null);
      index++;
    }
    empty(state);schedule(state);
  }
  async function refreshComments(state){
    for(const [id,entry] of state.comments)if(entry.open&&state.posts.has(id))await loadComments(state,id,false);
  }
  function invalidateComments(state){
    for(const entry of state.comments.values())if(entry.busy){entry.revision++;entry.queued=true;}
  }
  function changed(state){state.changeVersion++;invalidateComments(state);}
  async function listPage(admin=false){
    const selected=admin?adminScope:scope;
    paint(admin?'소식 모니터링':'소식','photo',
      (admin?`<div class="actions">${button('news-admin-reports','소식 신고 검토','secondary')}</div>`:`<section class="letter news-publish"><div><h2>사진으로 전하는 소식</h2><p>한 번에 사진 한 장을 12시간 동안 공개해요. 새 사진을 올리면 이전 사진의 공개가 끝나요.</p></div>${button('news-upload',icon('photo')+'사진 올리기','primary')}<input type="file" id="news-file" accept="image/*" hidden></section>`)+filters(selected)+'<div id="news-list" class="news-feed" aria-live="polite"></div>'+button('news-more','더 보기','news-more secondary'),
      {back:admin?adminBack:undefined,nav:admin?'':tabs('news'),sub:admin?'공개가 끝나거나 삭제된 사진도 업로드 후 24시간까지 확인할 수 있어요.':'새로 올라온 사진부터 보여드려요.'});
    const state=begin(admin,'feed');state.ready=false;if(!admin)wireTabs();
    const prefix=admin?'admin/news':'news';
    const path=cursor=>prefix+(selected.regional||cursor?'?'+new URLSearchParams({...selected.regional?{area:selected.area}:{},...cursor?{before:cursor}:{}}):'');
    state.refresh=async()=>{
      if(!alive(state)||!state.ready)return;if(state.busy){state.queued=true;return;}state.busy=true;
      const version=state.changeVersion;
      try{
        const wanted=Math.max(1,state.posts.size),posts=[];let cursor=null;
        do{const data=await api(path(cursor));if(!alive(state)||version!==state.changeVersion)return;posts.push(...data.items);cursor=data.nextCursor;}while(cursor&&posts.length<wanted);
        state.cursor=cursor;renderPosts(state,posts);$('#news-more').hidden=!cursor;
        await refreshComments(state);
      }finally{state.busy=false;if(state.queued&&alive(state)){state.queued=false;void state.refresh().catch(err);}}
    };
    bind($('#news-more'),'click',async()=>{
      if(state.busy||!state.cursor)return;state.busy=true;const control=$('#news-more'),version=state.changeVersion;control.disabled=true;
      try{const data=await api(path(state.cursor));if(!alive(state)||version!==state.changeVersion)return;state.cursor=data.nextCursor;renderPosts(state,[...state.posts.values(),...data.items]);control.hidden=!state.cursor;}
      finally{state.busy=false;control.disabled=false;if(state.queued&&alive(state)){state.queued=false;void state.refresh().catch(err);}}
    });
    if(admin)bind($('#news-admin-reports'),'click',adminReports);
    else{
      bind($('#news-upload'),'click',()=>$('#news-file').click());
      bind($('#news-file'),'change',async event=>{
        const file=event.target.files?.[0];event.target.value='';if(!file)return;
        const control=$('#news-upload');control.disabled=true;
        try{
          const photo=await jpeg(file);if(!alive(state))return;
          const own=await api('news/mine');if(!alive(state))return;state.mine=own.item;
          modal('소식 사진 올리기',own.item?'새 사진을 12시간 공개할까요? 지금 사진의 공개는 끝나요.':'사진을 12시간 동안 공개할까요?','올리기',async()=>{
            if(!alive(state))return;control.disabled=true;
            try{await api('news',{photo});if(alive(state)){changed(state);await state.refresh();note('사진을 올렸어요. 12시간 동안 공개돼요.');}}
            finally{if(alive(state))control.disabled=false;}
          });
        }finally{if(alive(state))control.disabled=false;}
      });
    }
    await wireScope(state,selected,()=>listPage(admin));if(!alive(state))return;state.ready=true;
    await state.refresh();if(alive(state))watch(state);
  }
  function commentMarkup(comment,state){
    const original=state.admin?comment.body:comment.visibility==='visible'?comment.body:null;
    const status=comment.visibility==='reported'?'신고 접수 · 댓글 검토 중':comment.visibility==='removed'?'이용규칙에 따라 숨겨진 댓글이에요.':'삭제된 댓글이에요.';
    return `<article class="news-comment ${!state.admin&&comment.mine?'news-comment-mine':''}" data-news-comment="${comment.id}"><header><strong>${state.admin?esc(comment.author?.nick||'작성자'):comment.mine?'내 댓글':'익명'}</strong><time>${esc(time(comment.created))}</time></header>${state.admin&&(comment.deletedAt||comment.visibility==='removed')?'<span class="deleted-label">'+(comment.deletedAt?'삭제된 댓글':'신고 인정 · 숨김')+'</span>':''}<p>${esc(original??status)}</p><div class="news-comment-actions">${state.admin?`<button type="button" class="textBtn" data-news-action="comment-author" data-comment-id="${comment.id}">작성자 정보</button>`:comment.mine?`<button type="button" class="textBtn danger" data-news-action="delete-comment" data-comment-id="${comment.id}">삭제</button>`:comment.visibility==='visible'?`<button type="button" class="textBtn danger" data-news-action="report-comment" data-comment-id="${comment.id}">신고</button>`:''}</div></article>`;
  }
  async function loadComments(state,id,earlier=false){
    const post=state.posts.get(id);if(!alive(state)||!post||!canRead(state,post))return;
    let entry=state.comments.get(id);if(!entry){entry={items:new Map(),cursor:null,open:true,busy:false,revision:0,queued:false};state.comments.set(id,entry);}
    if(entry.busy){entry.revision++;entry.queued=true;return;}entry.busy=true;
    const revision=entry.revision;
    try{
      const suffix=earlier&&entry.cursor?'?before='+encodeURIComponent(entry.cursor):'';
      const data=await api((state.admin?'admin/':'')+'news/'+id+'/comments'+suffix);
      if(!alive(state)||state.comments.get(id)!==entry||entry.revision!==revision||!state.posts.has(id)||!canRead(state,state.posts.get(id)))return;
      // Refresh every loaded page so deletions or reports cannot leave an older
      // comment's original text on screen indefinitely.
      const wanted=entry.items.size;let values=[...data.items],cursor=data.nextCursor;
      if(!earlier)while(cursor&&values.length<wanted){const page=await api((state.admin?'admin/':'')+'news/'+id+'/comments?before='+encodeURIComponent(cursor));if(!alive(state)||state.comments.get(id)!==entry||entry.revision!==revision)return;values.unshift(...page.items);cursor=page.nextCursor;}
      if(earlier)values=[...values,...entry.items.values()];
      entry.items=new Map(values.filter(c=>!expired(c.expiresAt)&& (state.admin||!c.deletedAt)).map(c=>[c.id,c]));entry.cursor=cursor;
      const node=state.list.querySelector(`[data-news-post="${id}"]`);if(!node)return;
      const list=node.querySelector('[data-news-role="comment-list"]'),markup=[...entry.items.values()].sort((a,b)=>a.id-b.id).map(c=>commentMarkup(c,state)).join('')||'<p class="note">아직 댓글이 없어요.</p>';
      if(list.dataset.markup!==markup){list.innerHTML=markup;list.dataset.markup=markup;}
      node.querySelector('[data-news-action="older-comments"]').hidden=!entry.cursor;
    }catch(error){
      if(alive(state)&&[403,404,410].includes(error.status)){state.comments.delete(id);const node=state.list?.querySelector(`[data-news-post="${id}"]`);node?.querySelector('[data-news-role="comment-list"]')?.replaceChildren();void state.refresh().catch(err);return;}
      throw error;
    }finally{entry.busy=false;if(entry.queued&&alive(state)&&state.comments.get(id)===entry&&state.posts.has(id)){entry.queued=false;void loadComments(state,id).catch(err);}}
  }
  async function sendComment(state,id,form){
    const post=state.posts.get(id);if(!alive(state)||!post||!canRead(state,post))return;
    const input=form.querySelector('textarea'),draft=input.value,body=draft.trim();if(!body)throw new Error('댓글을 입력해 주세요.');
    const submit=form.querySelector('[type="submit"]');if(submit.disabled)return;submit.disabled=true;
    try{await api('news/'+id+'/comments',{body});if(!alive(state)||!state.posts.has(id))return;changed(state);if(input.value===draft)input.value='';await state.refresh();}
    finally{submit.disabled=false;}
  }
  async function handleCardAction(state,id,event){
    const control=event.target.closest('[data-news-action]');if(!control||control.disabled)return;
    const post=state.posts.get(id);if(!alive(state)||!post||!canRead(state,post))return;
    const action=control.dataset.newsAction,commentId=Number(control.dataset.commentId),comment=state.comments.get(id)?.items.get(commentId);
    if(action==='profile')return state.admin?openMember(post.author.id,()=>adminDetail(id,()=>adminFeed())):openProfile(post.author.id);
    if(action==='detail')return adminDetail(id,()=>adminFeed());
    if(action==='comments'){
      const panel=control.closest('[data-news-post]').querySelector('[data-news-role="comments"]');panel.hidden=!panel.hidden;
      if(state.comments.has(id))state.comments.get(id).open=!panel.hidden;
      if(!panel.hidden)return loadComments(state,id);
    }
    if(action==='older-comments')return loadComments(state,id,true);
    if(action==='like'){
      if(state.pendingLikes.has(id))return;state.pendingLikes.add(id);control.disabled=true;
      try{const result=await api('news/'+id+'/like',{liked:!post.liked});if(alive(state)&&state.posts.has(id)){changed(state);Object.assign(state.posts.get(id),result);updateCard(control.closest('[data-news-post]'),state.posts.get(id),state);void state.refresh().catch(err);}}
      finally{state.pendingLikes.delete(id);if(alive(state)&&state.posts.has(id))control.disabled=state.posts.get(id).visibility!=='visible';}
    }
    if(action==='report')report(state,'post',id);
    if(action==='report-comment'&&comment)report(state,'comment',commentId);
    if(action==='delete')modal('소식 사진 삭제','소식 사진을 공개 목록에서 삭제할까요?','삭제',async()=>{if(!alive(state))return;await api('news/'+id+'/delete',{confirm:true});if(alive(state)){changed(state);state.comments.delete(id);state.posts.delete(id);state.list.querySelector(`[data-news-post="${id}"]`)?.remove();await state.refresh();note('소식 사진을 삭제했어요.');}});
    if(action==='delete-comment'&&comment)modal('댓글 삭제','댓글을 삭제할까요?','삭제',async()=>{if(!alive(state))return;await api('news/comments/'+commentId+'/delete',{confirm:true});if(alive(state)){changed(state);state.comments.get(id)?.items.delete(commentId);state.list.querySelector(`[data-news-comment="${commentId}"]`)?.remove();await loadComments(state,id);await state.refresh();note('댓글을 삭제했어요.');}});
    if(action==='comment-author'&&comment?.author?.id)return openMember(comment.author.id,()=>adminDetail(id,()=>adminFeed()));
  }
  function report(state,kind,id){
    if(document.querySelector('dialog[open]'))return;
    const dialog=document.createElement('dialog');dialog.className='dialog report-dialog';
    dialog.innerHTML=`<h2>${kind==='post'?'소식 사진':'익명 댓글'} 신고</h2><form id="news-report-form"><label for="news-report-reason">신고 사유</label><select id="news-report-reason" required><option value="">선택해 주세요</option>${reasons.map(reason=>`<option value="${esc(reason)}">${esc(reason)}</option>`).join('')}</select><p class="note">신고가 접수되면 해당 ${kind==='post'?'사진':'댓글'}은 검토 중으로 표시돼요.</p><p class="error" id="news-report-error" role="alert"></p><div class="actions">${button('news-report-cancel','취소')}<button type="submit" class="danger fill">신고 접수</button></div></form>`;
    $('#app').append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
    bind(dialog.querySelector('#news-report-cancel'),'click',()=>dialog.close());
    bind(dialog.querySelector('form'),'submit',async event=>{
      const submit=event.currentTarget.querySelector('[type="submit"]'),reason=dialog.querySelector('select').value;if(!reason||submit.disabled)return;submit.disabled=true;
      try{await api('news/report',{kind,id,reason});if(!alive(state))return;changed(state);dialog.close();await state.refresh();note('신고를 접수했어요.');}
      catch(error){if(!error.stale&&alive(state))dialog.querySelector('#news-report-error').textContent=error.message;}
      finally{submit.disabled=false;}
    });
  }
  async function adminDetail(id,back=adminFeed){
    paint('소식 상세','photo','<div id="news-list" class="news-feed"></div>',{back,sub:'사진과 댓글 원문은 사진 업로드 후 24시간까지 보관돼요.'});
    const state=begin(true,'detail');
    state.refresh=async()=>{
      if(!alive(state)||state.busy)return;state.busy=true;
      try{const data=await api('admin/news/'+id);if(!alive(state))return;renderPosts(state,[data.item]);const node=state.list.querySelector(`[data-news-post="${id}"]`);if(node){node.querySelector('[data-news-action="detail"]').hidden=true;node.querySelector('[data-news-role="comments"]').hidden=false;await loadComments(state,id);}}
      catch(error){if(alive(state)&&[404,410].includes(error.status)){renderPosts(state,[]);return;}throw error;}
      finally{state.busy=false;}
    };
    await state.refresh();if(alive(state))watch(state);
  }
  async function openPost(id){
    if(!Number.isSafeInteger(id)||id<1)return feed();
    paint('소식','photo','<div id="news-list" class="news-feed"></div>',{back:feed,sub:'사진과 익명 댓글을 확인해 보세요.'});
    const state=begin(false,'detail');state.ready=true;
    state.refresh=async()=>{
      if(!alive(state))return;if(state.busy){state.queued=true;return;}state.busy=true;
      const version=state.changeVersion;
      try{
        const data=await api('news/'+id);if(!alive(state)||state.changeVersion!==version)return;
        renderPosts(state,[data.item]);const node=state.list.querySelector(`[data-news-post="${id}"]`);
        if(node&&data.item.visibility==='visible'){
          node.querySelector('[data-news-role="comments"]').hidden=false;
          await loadComments(state,id);
        }
      }catch(error){
        if(alive(state)&&[404,410].includes(error.status)){renderPosts(state,[]);return;}
        throw error;
      }finally{
        state.busy=false;
        if(state.queued&&alive(state)){state.queued=false;void state.refresh().catch(err);}
      }
    };
    await state.refresh();if(alive(state))watch(state);
  }
  function renderReportList(state){
    const list=$('#news-report-list');if(!alive(state)||!list)return;
    const markup=[...state.reports.values()].map(r=>`<button type="button" class="row" data-news-report="${r.id}"><span><strong>${esc(r.author?.nick||'게시자')} · ${r.kind==='post'?'사진':'댓글'}</strong><small>${esc(r.reason)} · ${esc(time(r.created))}${expired(r.expiresAt)?' · 원문 만료':''}</small></span>${icon('arrow')}</button>`).join('')||'<p class="empty">접수된 소식 신고가 없어요.</p>';
    if(list.dataset.markup!==markup){list.innerHTML=markup;list.dataset.markup=markup;}
  }
  async function adminReports(){
    paint('소식 신고 검토','book','<section class="paper"><div id="news-report-list" class="rows"></div></section>',{back:adminFeed,sub:'소식 사진과 익명 댓글에 접수된 신고예요.'});
    const state=begin(true,'reports');
    state.refresh=async()=>{if(!alive(state)||state.busy)return;state.busy=true;try{const data=await api('admin/news/reports');if(!alive(state))return;state.reports=new Map(data.items.map(r=>[r.id,r]));renderReportList(state);schedule(state);}finally{state.busy=false;}};
    bind($('#news-report-list'),'click',event=>{const row=event.target.closest('[data-news-report]');if(row){const report=state.reports.get(Number(row.dataset.newsReport));if(report)return adminReport(report);}});
    await state.refresh();if(alive(state))watch(state);
  }
  function reportEvidence(state){
    const report=state.report,evidence=$('#news-report-evidence');if(!report||!evidence)return;
    const gone=expired(report.expiresAt),markup=gone?'':report.kind==='post'&&report.viewable?`<img src="/api/admin/news/${report.postId}/photo" alt="신고된 소식 사진 원본" draggable="false">`:report.kind==='comment'?`<p class="memo">${esc(report.excerpt||'현재 확인할 수 있는 댓글 원문이 없어요.')}</p>`:'<p class="note">사진 원본을 확인할 수 없어요.</p>';
    if(evidence.dataset.markup!==markup){evidence.innerHTML=markup;evidence.dataset.markup=markup;}
    $('#news-report-status').textContent=gone?'업로드 후 24시간이 지나 원문이 삭제됐어요.':'원문 삭제 · '+time(report.expiresAt);
    $('#news-report-accept').disabled=gone;schedule(state);
  }
  async function adminReport(selected){
    const id=typeof selected==='object'?selected.id:selected,opening=getEpoch();
    const queue=await api('admin/news/reports');if(opening!==getEpoch())return;
    const report=queue.items.find(item=>item.id===id);
    if(!report){await adminReports();note('처리되었거나 삭제된 신고예요.');return;}
    paint('소식 신고 상세','book',`<section class="paper"><h2>${esc(report.author?.nick||'작성자')}</h2><p>${esc(report.reason)}</p><p class="note">신고자 · ${esc(report.reporter?.nick||'회원')}</p><div class="actions">${button('news-report-author','작성자 정보','secondary')}${button('news-report-reporter','신고자 정보')}${button('news-report-post','소식 원문 보기')}</div><p class="note" id="news-report-status"></p><div id="news-report-evidence" class="news-report-evidence"></div><div class="actions">${button('news-report-dismiss','신고 거부 · 복원')}${button('news-report-accept','신고 인정 · 벌점 1점','danger')}</div><p class="note">신고를 인정하면 해당 콘텐츠의 공개를 중단하고 작성자에게 벌점 1점을 부여해요. 원문은 사진 업로드 후 24시간까지 보관돼요.</p></section>`,{back:adminReports});
    const state=begin(true,'report');state.report=report;
    const reopen=()=>adminReport(report.id);
    bind($('#news-report-author'),'click',()=>openMember(report.author.id,reopen));
    bind($('#news-report-reporter'),'click',()=>openMember(report.reporter.id,reopen));
    bind($('#news-report-post'),'click',()=>adminDetail(report.postId,reopen));
    const decide=async action=>{if(!alive(state))return;await api('admin/news/reports',{id:report.id,action});if(alive(state)){await adminReports();note('검토 결과를 반영했어요.');}};
    bind($('#news-report-dismiss'),'click',()=>decide('dismiss'));
    bind($('#news-report-accept'),'click',()=>modal('소식 신고 인정','해당 콘텐츠의 공개를 중단하고 작성자에게 벌점 1점을 부여할까요?','신고 인정',()=>decide('accept')));
    state.refresh=async()=>{
      if(!alive(state)||state.busy)return;state.busy=true;
      try{const data=await api('admin/news/reports');if(!alive(state))return;const current=data.items.find(r=>r.id===report.id);if(!current){await adminReports();note('처리된 신고예요. 목록으로 돌아왔어요.');return;}state.report=current;reportEvidence(state);}
      finally{state.busy=false;}
    };
    reportEvidence(state);watch(state);
  }
  function handleEvent(){if(active&&alive(active)&&foregroundVisible()){changed(active);expire(active);void active.refresh().catch(err);}}
  const feed=()=>listPage(false),adminFeed=()=>listPage(true);
  return {feed,adminFeed,openPost,dispose,handleEvent};
}
