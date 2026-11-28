import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsUI } from '../public/news.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

// This adapter models only the card's DOM operations, not its layout. The real
// module owns requests, events, timers, markup and draft updates in these tests.
class Element {
  constructor(tag='div') {
    this.tag=tag;this.dataset={};this.attributes={};this.listeners=new Map();this.parts=new Map();
    this.children=[];this.parentElement=null;this.hidden=false;this.disabled=false;this.value='';
    this.selectionStart=0;this.selectionEnd=0;this.writes=[];this._html='';
  }
  set innerHTML(value) {
    this._html=value;this.writes.push(value);this.parts.clear();this.children=[];
    for(const match of value.matchAll(/data-news-(action|role)="([^"]+)"/g)){
      const node=new Element();node.dataset[match[1]==='action'?'newsAction':'newsRole']=match[2];node.parentElement=this;
      this.parts.set('[data-news-'+match[1]+'="'+match[2]+'"]',node);
      if(match[1]==='role'&&match[2]==='comments')node.hidden=true;
    }
    if(value.includes('<form')){
      const form=new Element('form'),input=new Element('textarea'),submit=new Element('button');
      form.parentElement=this;input.parentElement=form;submit.parentElement=form;
      form.parts.set('textarea',input);form.parts.set('[type="submit"]',submit);this.parts.set('form',form);
    }
    const source=value.match(/<img[^>]*src="([^"]+)"/);
    if(source){const image=new Element('img');image.parentElement=this;image.attributes.src=source[1];this.parts.set('img',image);}
    if(value.includes('news-empty')){const empty=new Element();empty.parentElement=this;this.parts.set('.news-empty',empty);}
  }
  get innerHTML(){return this._html;}
  querySelector(selector) {
    const post=selector.match(/^\[data-news-post="(\d+)"\]$/);
    if(post)return this.children.find(node=>node.dataset.newsPost===post[1])||null;
    return this.parts.get(selector)||null;
  }
  closest(selector) {
    if(selector==='[data-news-action]'&&this.dataset.newsAction)return this;
    if(selector==='[data-news-post]'&&this.dataset.newsPost)return this;
    return this.parentElement?.closest(selector)||null;
  }
  addEventListener(name,callback){this.listeners.set(name,callback);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  insertBefore(node,before) {
    node.remove();node.parentElement=this;
    const index=before?this.children.indexOf(before):-1;
    if(index<0)this.children.push(node);else this.children.splice(index,0,node);
  }
  remove() {
    if(this.parentElement){
      this.parentElement.children=this.parentElement.children.filter(node=>node!==this);
      for(const [key,node]of this.parentElement.parts)if(node===this)this.parentElement.parts.delete(key);
    }
    this.parentElement=null;
  }
  replaceChildren(){this.innerHTML='';}
  get isConnected(){return Boolean(this.parentElement);}
}

function harness(reply) {
  const nodes=new Map(),intervals=new Map(),requests=[],errors=[];let epoch=0,timerId=0,expiry=null,ui;
  const app=new Element();nodes.set('#app',app);
  const document={querySelector:selector=>nodes.get(selector)||null,createElement:tag=>new Element(tag)};
  const paint=()=>{
    ui?.dispose();epoch++;app.children=[];
    for(const id of ['news-list','news-more','news-scope-all','news-scope-area','news-upload','news-file','news-admin-reports']){
      const element=new Element();element.parentElement=app;nodes.set('#'+id,element);
    }
  };
  ui=createNewsUI({document,window:{setInterval(fn,ms){const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id)},
    api:async(path,body)=>{requests.push({path,body});return reply(path,body);},paint,tabs:()=>'',wireTabs(){},getEpoch:()=>epoch,
    getMe:()=>({id:'viewer',area:'서울 동부'}),foregroundVisible:()=>true,scope:{},adminScope:{},getRegions:async()=>({}),
    picker:()=>'',wirePicker(){},areaOf:()=>'',knownArea:()=>false,
    esc:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    icon:()=>'',modal(){},note(){},err:error=>errors.push(error),jpeg:async()=>'',reasons:[],openProfile(){},openMember(){},adminBack(){},
    scheduleExpiry:(deadlines,callback)=>{expiry={deadlines,callback};}
  });
  const card=()=>nodes.get('#news-list').querySelector('[data-news-post="1"]');
  const comments=()=>card()?.querySelector('[data-news-role="comment-list"]');
  return {ui,requests,errors,intervals,card,comments,expiry:()=>expiry,
    openComments(){const node=card();return node.listeners.get('click')({target:node.querySelector('[data-news-action="comments"]')});},
    poll(){assert.equal(intervals.size,1);const timer=[...intervals.values()][0];assert.equal(timer.ms,4000);timer.fn();},
    leave(){ui.dispose();epoch++;nodes.get('#news-list').replaceChildren();}
  };
}

function content() {
  const created=Date.now(),expiresAt=created+24*3600000;
  return {post:{id:1,created,expiresAt,publicUntil:created+12*3600000,mine:false,visibility:'visible',viewable:1,
    author:{id:'owner',nick:'사진 작성자',area:'서울 동부'},likeCount:0,liked:false,commentCount:1},
    comment:{id:9,body:'신고 이전 응답의 비공개 원문',created,expiresAt,mine:false,visibility:'visible'}};
}

test('댓글 조회 중 신고·삭제 신호가 오면 늦은 이전 원문을 렌더하지 않고 4초 폴링 전에 즉시 재조회한다',async()=>{
  for(const deleted of [false,true]){
    const {post,comment}=content(),oldResponse=deferred(),currentResponse=deferred();let commentRequests=0;
    const b=harness(path=>{
      if(path==='news')return {items:[post],nextCursor:null};
      assert.equal(path,'news/1/comments');commentRequests++;
      if(commentRequests===1)return oldResponse.promise;
      if(commentRequests===2)return currentResponse.promise;
      throw Error('예상하지 않은 추가 조회');
    });
    await b.ui.feed();const opening=b.openComments();await settle();assert.equal(commentRequests,1);
    const input=b.card().querySelector('form').querySelector('textarea'),list=b.comments();
    input.value='계속 작성하는 익명 댓글 초안';input.selectionStart=3;input.selectionEnd=8;
    // These are SSE notifications; the interval callback is deliberately never invoked.
    b.ui.handleEvent();b.ui.handleEvent();await settle();assert.equal(commentRequests,1);
    oldResponse.resolve({items:[comment],nextCursor:null});await opening;await settle();
    assert.equal(commentRequests,2,'오래된 요청이 끝나는 즉시 갱신을 요청해야 합니다.');
    assert.equal(list.writes.some(html=>html.includes(comment.body)),false,'신고 전 원문을 중간 DOM에도 쓰면 안 됩니다.');
    assert.equal(input.value,'계속 작성하는 익명 댓글 초안');assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,8);
    currentResponse.resolve({items:deleted?[]:[{...comment,body:null,visibility:'reported'}],nextCursor:null});await settle();
    assert.doesNotMatch(list.innerHTML,/신고 이전 응답의 비공개 원문/);
    assert.match(list.innerHTML,deleted?/아직 댓글이 없어요/:/댓글 검토 중/);
    assert.equal(commentRequests,2);assert.deepEqual(b.errors,[]);assert.equal([...b.intervals.values()][0].ms,4000);
    b.ui.dispose();assert.equal(b.intervals.size,0);
  }
});

test('재조회 대기 중 화면을 떠나면 지연 댓글 응답이 화면이나 초안을 되살리거나 다음 요청을 만들지 않는다',async()=>{
  const {post,comment}=content(),oldResponse=deferred();let commentRequests=0;
  const b=harness(path=>{
    if(path==='news')return {items:[post],nextCursor:null};
    assert.equal(path,'news/1/comments');commentRequests++;return oldResponse.promise;
  });
  await b.ui.feed();const opening=b.openComments();await settle();const list=b.comments();
  b.ui.handleEvent();await settle();b.leave();oldResponse.resolve({items:[comment],nextCursor:null});await opening;await settle();
  assert.equal(commentRequests,1);assert.equal(list.writes.some(html=>html.includes(comment.body)),false);
  assert.equal(b.card(),null);assert.equal(b.intervals.size,0);assert.deepEqual(b.errors,[]);
});

test('공개 12시간이 댓글 요청 도중 끝나면 사진 카드를 제거하고 늦은 응답과 예약 재조회도 폐기한다',async t=>{
  let now=Date.UTC(2026,10,28);t.mock.method(Date,'now',()=>now);
  const {post,comment}=content(),response=deferred();let commentRequests=0;
  const b=harness(path=>{
    if(path==='news')return {items:[post],nextCursor:null};
    assert.equal(path,'news/1/comments');commentRequests++;return response.promise;
  });
  await b.ui.feed();const opening=b.openComments();await settle();const list=b.comments();
  b.ui.handleEvent();await settle();assert.ok(b.expiry().deadlines.includes(post.publicUntil));
  now=post.publicUntil;b.expiry().callback();assert.equal(b.card(),null);
  response.resolve({items:[comment],nextCursor:null});await opening;await settle();
  assert.equal(b.card(),null);assert.equal(commentRequests,1);
  assert.equal(list.writes.some(html=>html.includes(comment.body)),false);assert.deepEqual(b.errors,[]);b.ui.dispose();
});

test('소식 알림의 상세 화면은 해당 공개 사진과 익명 댓글을 바로 열고 만료 항목은 복원하지 않는다',async()=>{
 const {post,comment}=content();
 const b=harness(path=>path==='news/1'?{item:post}:{items:[comment],nextCursor:null});
 await b.ui.openPost(1);assert.deepEqual(b.requests.map(r=>r.path),['news/1','news/1/comments']);
 assert.equal(b.card().querySelector('[data-news-role="comments"]').hidden,false);assert.match(b.comments().innerHTML,/익명/);assert.doesNotMatch(b.comments().innerHTML,/data-author|owner/);b.ui.dispose();
 const gone=harness(()=>{throw Object.assign(new Error('만료된 소식'),{status:404});});await gone.ui.openPost(1);
 assert.equal(gone.card(),null);assert.deepEqual(gone.requests.map(r=>r.path),['news/1']);assert.deepEqual(gone.errors,[]);gone.ui.dispose();
});

test('소식 알림 상세 조회 중 새 신호가 오면 늦은 사진 응답을 쓰지 않고 즉시 재확인한다',async()=>{
 const {post,comment}=content(),old=deferred();let calls=0;
 const b=harness(path=>{if(path==='news/1'){calls++;if(calls===1)return old.promise;throw Object.assign(new Error('교체된 사진'),{status:404});}return {items:[comment],nextCursor:null};});
 const opening=b.ui.openPost(1);await settle();b.ui.handleEvent();old.resolve({item:post});await opening;await settle();
 assert.equal(calls,2);assert.equal(b.card(),null);assert.equal(b.requests.some(r=>r.path.endsWith('/comments')),false);assert.deepEqual(b.errors,[]);b.ui.dispose();
});
