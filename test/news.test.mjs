import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { makeServer } from '../server.mjs';
import { openStore,clean,hour } from '../store.mjs';
import { policyVersion } from '../public/rules.js';

const photo=Buffer.from([255,216,11,12,13,255,217]),day=24*hour;
const reason='괴롭힘·기타 위반';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'paperchat-news-')),origin='https://paperchat.example';
  let now=Date.UTC(2026,10,28,0,0,0),approved=true;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
  const config={dir,origin,secret:randomBytes(40).toString('hex'),pushProvider:{enabled:()=>false},
    webPushProvider:{publicKey:'test-public-key',enabled:()=>false}};
  const upstream={async check(){return {status:approved?'approved':'expired',token:'test-token'};}};
  let server=makeServer(config,upstream);
  const db=openStore(dir);
  t.after(()=>{server.emit('close');db.close();rmSync(dir,{recursive:true,force:true});});
  function client() {
    const cookies=new Map();
    const call=async(path,body,options={})=>{
      const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
      req.method=body===undefined?'GET':'POST';req.url=path;req.socket={remoteAddress:randomUUID()};
      req.headers={'content-type':'application/json',origin:options.origin??origin,'user-agent':'test-browser',
        cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),...options.headers};
      return new Promise((resolve,reject)=>{
        const headers={};
        const res={status:200,getHeader(key){return headers[key.toLowerCase()];},setHeader(key,value){headers[key.toLowerCase()]=value;},
          writeHead(status,h){this.status=status;for(const [key,value]of Object.entries(h||{}))this.setHeader(key,value);},
          end(bytes){for(const entry of headers['set-cookie']||[]){const [key,value]=entry.split(';')[0].split('=');cookies.set(key,value);}
            resolve({status:this.status,headers,body:headers['content-type']?.startsWith('application/json')?JSON.parse(bytes):bytes});}};
        try{server.emit('request',req,res);}catch(error){reject(error);}
      });
    };
    return call;
  }
  async function member(nick,area='서울 동부') {
    const call=client();
    assert.equal((await call('/api/key',{code:'reusable-news-key'})).status,200);
    assert.equal((await call('/api/profile-details',{nick,birthDate:'1995-01-03',gender:'여성'})).status,200);
    assert.equal((await call('/api/register',{area,memo:'소식 검증 소개글',policy:policyVersion})).status,200);
    return {call,id:(await call('/api/state')).body.profile.id,nick};
  }
  async function admin(call=client()) {
    assert.equal((await call('/api/admin/login',{key:'codenote-news-kyh'})).status,200);return call;
  }
  const identity=member=>db.prepare('SELECT identity FROM members WHERE id=?').get(member.id).identity;
  return {db,client,member,admin,identity,now:()=>now,advance(ms){now+=ms;},
    approved(value){approved=value;},restart(){server.emit('close');server=makeServer(config,upstream);}};
}

async function upload(member,bytes=photo) {
  const response=await member.call('/api/news',{photo:bytes.toString('base64')});
  assert.equal(response.status,200,JSON.stringify(response.body));return response.body.item;
}
async function comment(member,id,body) {
  const response=await member.call('/api/news/'+id+'/comments',{body});
  assert.equal(response.status,200,JSON.stringify(response.body));return response.body.item;
}
const feed=async(member,query='')=>{
  const response=await member.call('/api/news'+query);assert.equal(response.status,200);return response.body;
};
const photograph=(call,id,admin=false)=>call('/api/'+(admin?'admin/':'')+'news/'+id+'/photo');
const report=(member,kind,id)=>member.call('/api/news/report',{kind,id,reason});
const newsIds=body=>body.items.map(item=>item.id);
const reports=async admin=>{
  const response=await admin('/api/admin/news/reports');assert.equal(response.status,200);return response.body.items;
};
const decide=(admin,id,action)=>admin('/api/admin/news/reports',{id,action});

test('소식은 인증·동의·제한 및 Origin을 확인하며 잘못된 사진은 현재 사진을 교체하지 않는다',async t=>{
  const f=fixture(t),a=await f.member('사진 작성자'),b=await f.member('관람자'),admin=await f.admin(),nobody=f.client();
  const item=await upload(a);
  for(const [path,body]of [
    ['/api/news'],['/api/news/mine'],['/api/news/'+item.id+'/photo'],['/api/news/'+item.id+'/comments'],
    ['/api/news',{photo:photo.toString('base64')}],['/api/news/'+item.id+'/like',{liked:true}],
    ['/api/news/'+item.id+'/comments',{body:'댓글'}],['/api/news/report',{kind:'post',id:item.id,reason}]
  ])assert.equal((await nobody(path,body)).status,401,path);
  assert.equal((await admin('/api/news')).status,401);
  assert.equal((await a.call('/api/news',{photo:photo.toString('base64')},{origin:'https://other.example'})).status,403);
  for(const body of [{},{photo:12},{photo:'invalid'},{photo:Buffer.from([255,216,1,2]).toString('base64')}])
    assert.equal((await a.call('/api/news',body)).status,400);
  const tooLarge=Buffer.alloc(1500001);tooLarge.writeUInt16BE(0xffd8,0);tooLarge.writeUInt16BE(0xffd9,tooLarge.length-2);
  assert.equal((await a.call('/api/news',{photo:tooLarge.toString('base64')})).status,400);
  assert.equal((await a.call('/api/news/mine')).body.item.id,item.id);
  assert.equal((await photograph(b.call,item.id)).status,200);
  f.db.prepare('DELETE FROM acceptances WHERE member=?').run(b.id);
  assert.equal((await b.call('/api/news')).status,403);assert.equal((await photograph(b.call,item.id)).status,403);
  await b.call('/api/policy',{version:policyVersion});
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(f.identity(b),f.now()+hour);
  assert.equal((await b.call('/api/news')).status,403);assert.equal((await photograph(b.call,item.id)).status,403);
  f.db.prepare('DELETE FROM restrictions').run();
  assert.equal((await b.call('/api/news/'+item.id+'/delete',{confirm:true})).status,404);
  assert.equal((await a.call('/api/news/'+item.id+'/delete',{confirm:false})).status,400);
  assert.equal((await b.call('/api/news/'+item.id+'/like',{liked:true},{headers:{'x-paperchat-member':a.id}})).status,409);
});

test('소식은 사진을 올린 순서이며 전국·현재 프로필 지역으로 조회하고 양방향 차단을 지킨다',async t=>{
  const f=fixture(t),a=await f.member('서울 사진','서울 동부'),b=await f.member('부산 사진','부산 전체'),c=await f.member('관람자','경기 남부');
  const first=await upload(a);f.advance(1000);const second=await upload(b);const third=await upload(c);
  assert.deepEqual(newsIds(await feed(c)),[third.id,second.id,first.id]);
  assert.deepEqual(newsIds(await feed(c,'?area='+encodeURIComponent('서울 동부'))),[first.id]);
  assert.deepEqual(newsIds(await feed(c,'?area='+encodeURIComponent('경기도 이천시'))),[third.id]);
  assert.equal((await c.call('/api/news?area='+encodeURIComponent('없는 지역'))).status,400);
  for(const before of ['oops','1','1:x','-1:2','Infinity:2','1:1.5'])
    assert.equal((await c.call('/api/news?before='+encodeURIComponent(before))).status,400,before);
  assert.deepEqual(newsIds(await feed(c,'?before='+second.created+':'+second.id)),[first.id]);
  const beforeThird=await feed(c,'?before='+third.created+':'+third.id);
  assert.deepEqual(newsIds(beforeThird),[second.id,first.id]);
  await a.call('/api/profile',{area:'부산 전체',memo:'지역을 바꿨습니다'});
  assert.deepEqual(newsIds(await feed(c,'?area='+encodeURIComponent('서울 동부'))),[]);
  assert.deepEqual(newsIds(await feed(c,'?area='+encodeURIComponent('부산 전체'))),[second.id,first.id]);
  await c.call('/api/blocks',{peer:a.id});
  assert.deepEqual(newsIds(await feed(c)),[third.id,second.id]);assert.equal((await photograph(c.call,first.id)).status,404);
  assert.deepEqual(newsIds(await feed(a)),[second.id,first.id]);assert.equal((await photograph(a.call,third.id)).status,404);
  assert.equal((await c.call('/api/news/'+first.id+'/like',{liked:true})).status,404);
  assert.equal((await report(c,'post',first.id)).status,404);
  await c.call('/api/blocks',{peer:a.id,remove:true});
  assert.deepEqual(newsIds(await feed(c)),[third.id,second.id,first.id]);
  f.db.prepare('INSERT INTO restrictions VALUES(?,?)').run(f.identity(a),f.now()+hour);
  assert.deepEqual(newsIds(await feed(c)),[third.id,second.id]);assert.equal((await photograph(c.call,first.id)).status,404);
});

test('한 회원의 새 사진과 본인 삭제는 이전 공개를 끝내고 관리자 보관은 원래 업로드의 24시간을 넘기지 않는다',async t=>{
  const f=fixture(t),a=await f.member('교체 작성자'),b=await f.member('관람자');let admin=await f.admin();
  const first=await upload(a);assert.equal(first.publicUntil,first.created+12*hour);assert.equal(first.expiresAt,first.created+day);
  f.advance(2*hour);const second=await upload(a);
  assert.deepEqual(newsIds(await feed(b)),[second.id]);assert.equal((await a.call('/api/news/mine')).body.item.id,second.id);
  assert.notEqual((await photograph(b.call,first.id)).status,200);assert.equal((await photograph(admin,first.id,true)).status,200);
  assert.equal((await a.call('/api/news/'+second.id+'/delete',{confirm:true})).status,200);
  assert.equal((await a.call('/api/news/'+second.id+'/delete',{confirm:true})).status,200);
  assert.deepEqual(newsIds(await feed(b)),[]);assert.equal((await a.call('/api/news/mine')).body.item,null);
  assert.equal((await photograph(admin,second.id,true)).status,200);
  f.advance(22*hour-1);admin=await f.admin(admin);
  assert.equal((await photograph(admin,first.id,true)).status,200);
  f.advance(1);assert.notEqual((await photograph(admin,first.id,true)).status,200);
  assert.equal((await photograph(admin,second.id,true)).status,200);
  clean(f.db,f.now());assert.equal((await photograph(admin,first.id,true)).status,404);
  assert.equal(f.db.prepare('SELECT 1 FROM news_posts WHERE id=?').get(first.id),undefined);
  f.advance(2*hour);assert.notEqual((await photograph(admin,second.id,true)).status,200);
  clean(f.db,f.now());assert.equal((await photograph(admin,second.id,true)).status,404);
  assert.equal(f.db.prepare('SELECT 1 FROM news_posts WHERE id=?').get(second.id),undefined);
});

test('공개는 정확히 업로드 12시간에 종료하고 사진·댓글은 업로드 24시간에 관리자에서도 정리된다',async t=>{
  const f=fixture(t),a=await f.member('시간 작성자'),b=await f.member('댓글 작성자');let admin=await f.admin();
  const item=await upload(a);f.advance(11*hour);const entry=await comment(b,item.id,'나중에 적어도 원래 사진과 같이 사라집니다');
  assert.equal(entry.expiresAt,item.created+day);
  f.advance(hour-1);assert.deepEqual(newsIds(await feed(b)),[item.id]);assert.equal((await photograph(b.call,item.id)).status,200);
  f.advance(1);assert.deepEqual(newsIds(await feed(b)),[]);assert.notEqual((await photograph(b.call,item.id)).status,200);
  assert.notEqual((await b.call('/api/news/'+item.id+'/comments')).status,200);
  assert.notEqual((await b.call('/api/news/'+item.id+'/like',{liked:true})).status,200);
  assert.notEqual((await b.call('/api/news/'+item.id+'/comments',{body:'공개가 끝난 후 댓글'})).status,200);
  admin=await f.admin(admin);assert.equal((await photograph(admin,item.id,true)).status,200);
  f.advance(12*hour-1);admin=await f.admin(admin);assert.equal((await photograph(admin,item.id,true)).status,200);
  f.advance(1);assert.notEqual((await photograph(admin,item.id,true)).status,200);
  f.restart();admin=await f.admin(admin);assert.equal((await photograph(admin,item.id,true)).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_posts').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_comments').get().n,0);
});

test('좋아요는 회원별 1개이며 반복·동시 요청과 해제를 정확한 수로 반영한다',async t=>{
  const f=fixture(t),a=await f.member('사진 주인'),b=await f.member('좋아요 하나'),c=await f.member('좋아요 둘'),item=await upload(a);
  const like=(member,liked)=>member.call('/api/news/'+item.id+'/like',{liked});
  for(const response of await Promise.all([like(b,true),like(b,true)]))assert.equal(response.status,200);
  assert.deepEqual((await like(b,true)).body,{liked:true,likeCount:1});
  assert.deepEqual((await like(c,true)).body,{liked:true,likeCount:2});
  const ownView=(await feed(b)).items[0],otherView=(await feed(a)).items[0];
  assert.equal(ownView.liked,true);assert.equal(otherView.liked,false);assert.equal(otherView.likeCount,2);
  assert.deepEqual((await like(b,false)).body,{liked:false,likeCount:1});assert.deepEqual((await like(b,false)).body,{liked:false,likeCount:1});
  for(const value of [null,'true',1])assert.equal((await like(b,value)).status,400);
  assert.equal((await b.call('/api/news/'+item.id+'/like',{liked:true},{origin:'https://other.example'})).status,403);
  assert.equal((await feed(a)).items[0].likeCount,1);
});

test('댓글의 일반 API는 작성자 정보를 노출하지 않고 본인 표시·금칙어·삭제 권한을 지킨다',async t=>{
  const f=fixture(t),a=await f.member('사진 소유자 비밀'),b=await f.member('댓글 실명 비밀'),c=await f.member('다른 실명 비밀'),item=await upload(a);
  const own=await comment(b,item.id,'  익명 댓글 원문  '),other=await comment(c,item.id,'다른 익명 댓글');
  const keys=['body','created','expiresAt','id','mine','visibility'];
  assert.deepEqual(Object.keys(own).sort(),keys);assert.equal(own.body,'익명 댓글 원문');assert.equal(own.mine,true);
  for(const member of [a,b,c]){
    const response=await member.call('/api/news/'+item.id+'/comments');assert.equal(response.status,200);
    const rows=response.body.items;assert.deepEqual(rows.map(row=>row.id),[own.id,other.id]);
    for(const row of rows)assert.deepEqual(Object.keys(row).sort(),keys);
    assert.equal(rows[0].mine,member===b);assert.equal(rows[1].mine,member===c);
    for(const source of [a,b,c]){assert.equal(JSON.stringify(response.body).includes(source.id),false);assert.equal(JSON.stringify(response.body).includes(source.nick),false);}
  }
  assert.equal((await b.call('/api/news/'+item.id+'/comments',{body:''})).status,400);
  assert.equal((await b.call('/api/news/'+item.id+'/comments',{body:'누드 사진 보내'})).status,422);
  assert.equal((await a.call('/api/news/comments/'+own.id+'/delete',{confirm:true})).status,404);
  assert.equal((await c.call('/api/news/comments/'+own.id+'/delete',{confirm:true})).status,404);
  assert.equal((await b.call('/api/news/comments/'+own.id+'/delete',{confirm:false})).status,400);
  assert.equal((await b.call('/api/news/comments/'+own.id+'/delete',{confirm:true})).status,200);
  assert.equal((await b.call('/api/news/comments/'+own.id+'/delete',{confirm:true})).status,200);
  const remaining=(await c.call('/api/news/'+item.id+'/comments')).body.items;
  assert.equal(remaining.some(row=>row.id===own.id),false);assert.equal(remaining[0].body,'다른 익명 댓글');
});

test('사진 신고는 원문 대신 검토중 표시로 숨기고 중복 신고·거부는 공개 마감과 좋아요를 바꾸지 않는다',async t=>{
  const f=fixture(t),a=await f.member('사진 작성자'),b=await f.member('첫 신고자'),c=await f.member('두 번째 신고자'),admin=await f.admin();
  const item=await upload(a);await b.call('/api/news/'+item.id+'/like',{liked:true});
  const entry=await comment(c,item.id,'사진 댓글');
  assert.equal((await report(a,'post',item.id)).status,404);
  assert.equal((await b.call('/api/news/report',{kind:'post',id:item.id,reason:'없는 사유'})).status,400);
  assert.equal((await b.call('/api/news/report',{kind:'unknown',id:item.id,reason})).status,400);
  assert.equal((await report(b,'post',item.id)).status,200);assert.equal((await report(b,'post',item.id)).status,200);
  assert.equal((await reports(admin)).length,1);
  assert.equal((await report(c,'post',item.id)).status,200);const pending=await reports(admin);
  assert.equal(pending.length,2);
  for(const member of [a,b,c]){
    const row=(await feed(member)).items.find(row=>row.id===item.id);assert.equal(row.visibility,'reported');
    assert.equal(row.publicUntil,item.publicUntil);assert.equal(row.expiresAt,item.expiresAt);
    assert.equal((await photograph(member.call,item.id)).status,403);
    assert.equal((await member.call('/api/news/'+item.id+'/comments')).status,403);
    assert.equal((await member.call('/api/news/'+item.id+'/like',{liked:true})).status,403);
  }
  assert.equal((await photograph(admin,item.id,true)).status,200);
  const adminComments=(await admin('/api/admin/news/'+item.id+'/comments')).body.items;
  assert.equal(adminComments[0].id,entry.id);assert.equal(adminComments[0].author.id,c.id);
  const first=pending.find(row=>row.reporter.id===b.id),second=pending.find(row=>row.reporter.id===c.id);
  assert.equal(first.author.id,a.id);assert.equal(first.postId,item.id);assert.equal(first.commentId,null);
  assert.equal((await decide(admin,first.id,'dismiss')).status,200);
  assert.equal((await photograph(b.call,item.id)).status,403);
  assert.equal((await decide(admin,second.id,'dismiss')).status,200);
  assert.equal((await photograph(b.call,item.id)).status,200);
  assert.equal((await feed(b)).items[0].likeCount,1);assert.equal((await feed(b)).items[0].publicUntil,item.publicUntil);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,0);
});

test('익명 댓글 신고는 본문만 숨기고 관리자에게만 작성자를 보여 주며 승인 벌점은 사진 작성자와 분리된다',async t=>{
  const f=fixture(t),a=await f.member('사진 소유자'),b=await f.member('익명 작성자 이름'),c=await f.member('신고자 이름'),admin=await f.admin();
  const item=await upload(a),entry=await comment(b,item.id,'신고 대상 댓글 원문');
  assert.equal((await report(b,'comment',entry.id)).status,404);
  const response=await report(c,'comment',entry.id);assert.equal(response.status,200);assert.deepEqual(response.body,{ok:true});
  for(const member of [a,b,c]){
    const rows=(await member.call('/api/news/'+item.id+'/comments')).body.items;
    assert.equal(rows[0].body,null);assert.equal(rows[0].visibility,'reported');assert.equal(rows[0].mine,member===b);
    assert.deepEqual(Object.keys(rows[0]).sort(),['body','created','expiresAt','id','mine','visibility']);
    for(const source of [a,b,c])assert.equal(JSON.stringify(rows).includes(source.id),false);
    assert.equal((await photograph(member.call,item.id)).status,200);
  }
  const [pending]=await reports(admin);assert.equal(pending.kind,'comment');assert.equal(pending.commentId,entry.id);
  assert.equal(pending.author.id,b.id);assert.equal(pending.author.nick,b.nick);assert.equal(pending.excerpt,'신고 대상 댓글 원문');
  assert.equal((await decide(admin,pending.id,'accept')).status,200);assert.equal((await decide(admin,pending.id,'accept')).status,200);
  assert.equal((await decide(admin,pending.id,'dismiss')).status,409);
  const adminRows=(await admin('/api/admin/news/'+item.id+'/comments')).body.items;
  assert.equal(adminRows.find(row=>row.id===entry.id).body,'신고 대상 댓글 원문');
  assert.equal(adminRows.find(row=>row.id===entry.id).visibility,'removed');
  const publicRows=(await c.call('/api/news/'+item.id+'/comments')).body.items;
  assert.equal(publicRows.some(row=>row.body==='신고 대상 댓글 원문'),false);
  assert.equal((await admin('/api/admin/members/'+b.id)).body.totalStrikes,1);
  assert.equal((await admin('/api/admin/members/'+a.id)).body.totalStrikes,0);
  assert.equal((await photograph(admin,item.id,true)).status,200);
});

test('신고 거부는 교체·본인 삭제·12시간 종료된 사진이나 삭제 댓글을 다시 공개하지 않는다',async t=>{
  const f=fixture(t),a=await f.member('교체'),b=await f.member('본인 삭제'),c=await f.member('시간 만료'),viewer=await f.member('신고자');let admin=await f.admin();
  const replaced=await upload(a),deleted=await upload(b),expired=await upload(c);
  const entry=await comment(b,replaced.id,'삭제할 익명 댓글');await report(viewer,'comment',entry.id);
  const commentReport=(await reports(admin)).find(row=>row.commentId===entry.id);
  await b.call('/api/news/comments/'+entry.id+'/delete',{confirm:true});
  assert.equal((await decide(admin,commentReport.id,'dismiss')).status,200);
  assert.equal((await viewer.call('/api/news/'+replaced.id+'/comments')).body.items.some(row=>row.id===entry.id),false);
  for(const item of [replaced,deleted,expired])assert.equal((await report(viewer,'post',item.id)).status,200);
  const pending=await reports(admin);f.advance(hour);const replacement=await upload(a);
  await b.call('/api/news/'+deleted.id+'/delete',{confirm:true});
  f.advance(11*hour);admin=await f.admin(admin);
  for(const item of [replaced,deleted,expired]){
    const row=pending.find(row=>row.postId===item.id);assert.equal((await decide(admin,row.id,'dismiss')).status,200);
    assert.notEqual((await photograph(viewer.call,item.id)).status,200);
    assert.equal((await photograph(admin,item.id,true)).status,200);
    const retained=(await admin('/api/admin/news/'+item.id)).body.item;
    assert.equal(retained.expiresAt,item.created+day);assert.equal(retained.publicUntil,item.created+12*hour);
  }
  assert.deepEqual(newsIds(await feed(viewer)),[replacement.id]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,0);
});

test('신고 승인은 같은 콘텐츠에 한 번만 벌점을 주고 세 번째 위반은 기존 체계대로 24시간 제한한다',async t=>{
  const f=fixture(t),author=await f.member('위반 작성자'),b=await f.member('첫 신고자'),c=await f.member('다른 신고자'),admin=await f.admin();
  const first=await upload(author);await report(b,'post',first.id);await report(c,'post',first.id);
  const samePost=await reports(admin);assert.equal(samePost.length,2);
  for(const row of samePost)assert.equal((await decide(admin,row.id,'accept')).status,200);
  assert.equal((await reports(admin)).length,0);assert.equal((await photograph(admin,first.id,true)).status,200);
  assert.notEqual((await photograph(b.call,first.id)).status,200);assert.equal((await report(c,'post',first.id)).status,404);
  assert.equal((await admin('/api/admin/members/'+author.id)).body.totalStrikes,1);
  const second=await upload(author);await report(b,'post',second.id);const [next]=await reports(admin);
  // Own deletion never removes the evidence needed to review an already submitted report.
  await author.call('/api/news/'+second.id+'/delete',{confirm:true});
  assert.equal((await decide(admin,next.id,'accept')).status,200);
  const third=await upload(author);await report(c,'post',third.id);const [last]=await reports(admin);
  assert.equal((await decide(admin,last.id,'accept')).status,200);
  const member=(await admin('/api/admin/members/'+author.id)).body;
  assert.equal(member.totalStrikes,3);assert.equal(member.strikes,0);assert.equal(member.restrictedUntil,f.now()+day);
  assert.equal((await author.call('/api/state')).body.stage,'restricted');
  assert.equal((await author.call('/api/news',{photo:photo.toString('base64')})).status,403);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,3);
});

test('관리자 소식 조회·판정은 재승인과 Origin을 요구하고 만료된 증거에는 벌점을 추가하지 않는다',async t=>{
  const f=fixture(t),a=await f.member('사진 작성자'),b=await f.member('신고자'),nobody=f.client();let admin=await f.admin();
  const item=await upload(a),entry=await comment(a,item.id,'24시간만 보관할 신고 원문');
  await report(b,'post',item.id);await report(b,'comment',entry.id);const pending=await reports(admin);
  for(const [path,body]of [
    ['/api/admin/news'],['/api/admin/news/'+item.id],['/api/admin/news/'+item.id+'/photo'],
    ['/api/admin/news/'+item.id+'/comments'],['/api/admin/news/reports'],
    ['/api/admin/news/reports',{id:pending[0].id,action:'accept'}]
  ])for(const call of [nobody,b.call])assert.equal((await call(path,body)).status,401,path);
  assert.equal((await admin('/api/admin/news/reports',{id:pending[0].id,action:'accept'},{origin:'https://other.example'})).status,403);
  assert.equal((await decide(admin,pending[0].id,'wrong')).status,400);
  assert.equal((await decide(admin,'invalid','accept')).status,400);
  f.approved(false);assert.equal((await admin('/api/admin/news')).status,401);
  f.approved(true);admin=await f.admin(admin);f.advance(day);admin=await f.admin(admin);
  const expiredQueue=await reports(admin);assert.equal(expiredQueue.some(row=>row.excerpt==='24시간만 보관할 신고 원문'),false);
  for(const row of pending)assert.ok([404,409].includes((await decide(admin,row.id,'accept')).status));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,0);
  clean(f.db,f.now());assert.deepEqual(await reports(admin),[]);
  assert.equal((await admin('/api/admin/news/'+item.id)).status,404);
  assert.equal((await admin('/api/admin/news/'+item.id+'/comments')).status,404);
});

test('댓글 작성자·사진 소유자의 직접 탈퇴와 관리자 회원 삭제는 관련 소식을 즉시 지우고 다른 회원 소식은 유지한다',async t=>{
  const f=fixture(t),a=await f.member('삭제할 사진'),b=await f.member('탈퇴할 댓글'),c=await f.member('남길 사진'),admin=await f.admin();
  const removed=await upload(a),kept=await upload(c);
  await comment(b,removed.id,'탈퇴자의 첫 댓글');await comment(b,kept.id,'탈퇴자의 다른 댓글');
  const retainedComment=await comment(c,kept.id,'남길 댓글');
  await a.call('/api/news/'+kept.id+'/like',{liked:true});await c.call('/api/news/'+removed.id+'/like',{liked:true});
  await report(b,'post',removed.id);
  assert.equal((await b.call('/api/withdraw',{confirm:true})).status,200);
  assert.equal((await b.call('/api/news')).status,401);
  assert.deepEqual((await c.call('/api/news/'+kept.id+'/comments')).body.items.map(row=>row.id),[retainedComment.id]);
  assert.equal((await admin('/api/admin/news/'+removed.id+'/comments')).body.items.length,0);
  assert.equal((await reports(admin)).length,0);
  assert.equal((await admin('/api/admin/members/'+a.id+'/delete',{confirm:true})).status,200);
  assert.equal((await a.call('/api/news')).status,401);
  assert.equal((await photograph(admin,removed.id,true)).status,404);
  assert.equal((await admin('/api/admin/news/'+removed.id+'/comments')).status,404);
  assert.deepEqual(newsIds(await feed(c)),[kept.id]);assert.equal((await feed(c)).items[0].likeCount,0);
  assert.equal((await photograph(c.call,kept.id)).status,200);
  assert.equal((await admin('/api/admin/news/'+kept.id+'/comments')).body.items[0].author.id,c.id);
});

test('서버 재시작은 소식·좋아요·신고 원본과 업로드 시각을 보존하고 전체 초기화는 모든 소식 테이블을 비운다',async t=>{
  const f=fixture(t),a=await f.member('계속 남을 작성자'),b=await f.member('계속 남을 신고자');let admin=await f.admin();
  const first=await upload(a);await comment(b,first.id,'재시작에도 기한 안에서만 남는 원문');
  await b.call('/api/news/'+first.id+'/like',{liked:true});await report(b,'post',first.id);
  f.advance(hour);const current=await upload(a);await b.call('/api/news/'+current.id+'/like',{liked:true});
  const pending=await reports(admin);
  f.restart();admin=await f.admin(admin);
  assert.equal((await a.call('/api/news/mine')).body.item.id,current.id);
  assert.equal((await feed(b)).items[0].likeCount,1);assert.equal((await feed(b)).items[0].liked,true);
  const retained=(await admin('/api/admin/news/'+first.id)).body.item;
  assert.equal(retained.created,first.created);assert.equal(retained.expiresAt,first.expiresAt);assert.equal(retained.publicUntil,first.publicUntil);
  assert.equal((await photograph(admin,first.id,true)).status,200);
  assert.equal((await admin('/api/admin/news/'+first.id+'/comments')).body.items[0].body,'재시작에도 기한 안에서만 남는 원문');
  assert.deepEqual((await reports(admin)).map(row=>row.id),pending.map(row=>row.id));
  const newsTables=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'news_*'").all().map(row=>row.name);
  assert.ok(newsTables.length>=4);
  assert.equal((await admin('/api/admin/reset',{key:'codenote-news-kyh',confirm:'전체 삭제'})).status,200);
  for(const table of newsTables)assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM "'+table+'"').get().n,0,table);
  assert.equal((await b.call('/api/news')).status,401);
});

test('사진과 댓글의 페이지 커서는 같은 시각에도 빠짐·중복 없이 공개 가능한 항목을 먼저 필터한다',async t=>{
  const f=fixture(t),a=await f.member('사진 소유자'),viewer=await f.member('읽는 회원'),blocked=await f.member('차단된 댓글 작성자'),admin=await f.admin();
  const visible=[];
  for(let index=0;index<43;index++){
    const id=randomUUID(),area=index%2?'부산 전체':'서울 동부';
    f.db.prepare('INSERT INTO members(id,identity,nick,year,gender,area,memo) VALUES(?,?,?,?,?,?,?)').run(id,'seed-'+id,'사진 '+index,1995,'여성',area,'페이지 검증');
    const post=f.db.prepare('INSERT INTO news_posts(author,created,photo) VALUES(?,?,?)').run(id,f.now(),photo);
    visible.unshift(Number(post.lastInsertRowid));
  }
  const older=await upload(a);await a.call('/api/news/'+older.id+'/delete',{confirm:true});
  async function collect(call,path){
    const ids=[];let cursor=null,pages=0;
    do{
      const response=await call(path+(cursor?(path.includes('?')?'&':'?')+'before='+encodeURIComponent(cursor):''));
      assert.equal(response.status,200);ids.push(...newsIds(response.body));cursor=response.body.nextCursor;pages++;
      assert.ok(pages<10,'커서는 같은 페이지를 반복하면 안 됩니다.');
    }while(cursor!==null);
    assert.equal(new Set(ids).size,ids.length);return {ids,pages};
  }
  const publicPages=await collect(viewer.call,'/api/news');assert.deepEqual(publicPages.ids,visible);assert.equal(publicPages.pages,3);
  const adminPages=await collect(admin,'/api/admin/news');assert.deepEqual(adminPages.ids,[older.id,...visible]);
  const regional=await collect(viewer.call,'/api/news?area='+encodeURIComponent('부산 전체'));
  assert.equal(regional.ids.length,21);assert.equal(regional.pages,2);
  const active=await upload(a),expected=[];
  for(let index=1;index<=121;index++){
    const author=index<=20 && index>10?blocked.id:a.id;
    const entry=f.db.prepare('INSERT INTO news_comments(post,author,created,body,deleted_at,state) VALUES(?,?,?,?,?,?)')
      .run(active.id,author,f.now(),'익명 과거 댓글 '+index,index<=5?f.now():null,index>5&&index<=10?'removed':'approved');
    if(index>20)expected.push(Number(entry.lastInsertRowid));
  }
  await viewer.call('/api/blocks',{peer:blocked.id});
  let cursor=null,found=[],pages=0;
  do{
    const response=await viewer.call('/api/news/'+active.id+'/comments'+(cursor?'?before='+cursor:''));
    assert.equal(response.status,200);const ids=newsIds(response.body);
    assert.deepEqual(ids,[...ids].sort((a,b)=>a-b));found=[...ids,...found];cursor=response.body.nextCursor;pages++;
    assert.ok(pages<5);
  }while(cursor!==null);
  assert.deepEqual(found,expected);assert.equal(pages,3);
  const allComments=await collect(admin,'/api/admin/news/'+active.id+'/comments');assert.equal(allComments.ids.length,121);
  for(const before of ['bad','-1','0','1.5'])assert.equal((await viewer.call('/api/news/'+active.id+'/comments?before='+before)).status,400);
});

test('사진 교체의 DB 실패는 이전 사진과 좋아요·댓글을 유지하고 동시 교체도 현재 사진 하나만 남긴다',async t=>{
  const f=fixture(t),a=await f.member('원자적 교체'),b=await f.member('관람자'),item=await upload(a);
  const entry=await comment(b,item.id,'실패해도 남는 댓글');await b.call('/api/news/'+item.id+'/like',{liked:true});
  f.db.exec("CREATE TRIGGER fail_news_upload BEFORE INSERT ON news_posts BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  const logging=t.mock.method(console,'error',()=>{});
  const failed=await a.call('/api/news',{photo:photo.toString('base64')});logging.mock.restore();
  assert.equal(failed.status,500);f.db.exec('DROP TRIGGER fail_news_upload');
  assert.equal((await a.call('/api/news/mine')).body.item.id,item.id);
  assert.equal((await photograph(b.call,item.id)).status,200);
  assert.equal((await feed(b)).items[0].likeCount,1);assert.equal((await b.call('/api/news/'+item.id+'/comments')).body.items[0].id,entry.id);
  const results=await Promise.all([upload(a),upload(a)]),current=(await a.call('/api/news/mine')).body.item;
  assert.ok(results.some(result=>result.id===current.id));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM news_posts WHERE author=? AND retired_at IS NULL').get(a.id).n,1);
  assert.deepEqual(newsIds(await feed(b)),[current.id]);
});

test('신고 인정 원문도 업로드 24시간에 사진·댓글·신고 복사와 함께 제거되며 벌점 기록만 유지한다',async t=>{
  const f=fixture(t),a=await f.member('인정 사진 작성자'),b=await f.member('인정 댓글 작성자'),reporter=await f.member('신고자');let admin=await f.admin();
  const item=await upload(a),entry=await comment(b,item.id,'24시간 뒤 남아서는 안 되는 원문');
  await report(reporter,'comment',entry.id);await report(reporter,'post',item.id);
  for(const row of await reports(admin))assert.equal((await decide(admin,row.id,'accept')).status,200);
  f.advance(day-1);admin=await f.admin(admin);
  assert.equal((await photograph(admin,item.id,true)).status,200);
  assert.equal((await admin('/api/admin/news/'+item.id+'/comments')).body.items[0].body,'24시간 뒤 남아서는 안 되는 원문');
  f.advance(1);assert.equal((await photograph(admin,item.id,true)).status,404);
  assert.equal((await admin('/api/admin/news/'+item.id+'/comments')).status,404);
  clean(f.db,f.now());
  for(const table of ['news_posts','news_comments','news_reports','news_likes'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0,table);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM penalty_events').get().n,2);
});

test('소식이 없던 기존 DB에 테이블을 추가해도 회원·복구키·기존 대화·세션과 설정은 바뀌지 않는다',async t=>{
  const f=fixture(t),a=await f.member('기존 회원'),b=await f.member('기존 상대');
  const room=(await a.call('/api/room',{peer:b.id})).body.id;
  await a.call('/api/rooms/'+room+'/messages',{body:'기존 대화 원문'});
  f.db.prepare("INSERT INTO settings VALUES('form','https://example.com/kept')").run();
  const select=()=>({members:f.db.prepare('SELECT * FROM members ORDER BY id').all(),keys:f.db.prepare('SELECT * FROM account_keys ORDER BY member').all(),
    messages:f.db.prepare('SELECT * FROM messages ORDER BY id').all(),sessions:f.db.prepare('SELECT * FROM sessions ORDER BY id').all(),settings:f.db.prepare('SELECT * FROM settings ORDER BY name').all()});
  const before=select();
  for(const table of ['news_push_jobs','news_push_targets','news_push_events','news_reports','news_likes','news_comments','news_posts'])f.db.exec('DROP TABLE '+table);
  f.restart();assert.deepEqual(select(),before);
  assert.equal((await a.call('/api/state')).body.profile.id,a.id);
  assert.equal((await b.call('/api/rooms/'+room+'/messages')).body[0].body,'기존 대화 원문');
  assert.deepEqual(newsIds(await feed(a)),[]);
  const item=await upload(a);f.restart();assert.equal((await a.call('/api/news/mine')).body.item.id,item.id);
});
