import { hour,transaction } from './store.mjs';
import { reject } from './providers.mjs';
import { checkText } from './moderation.mjs';
import { reasons } from './public/rules.js';

export const newsPublicTTL=12*hour,newsRetentionTTL=24*hour;
const photoLimit=1_500_000,pageSize=20,commentPageSize=50;
const postReported=`EXISTS(SELECT 1 FROM news_reports r WHERE r.post=n.id AND r.comment IS NULL AND r.status='open')`;
const commentReported=`EXISTS(SELECT 1 FROM news_reports r WHERE r.comment=c.id AND r.status='open')`;
const postColumns=`n.id,n.author,n.created,n.retired_at,n.retired_reason,n.state,
  n.photo IS NOT NULL AS hasPhoto,${postReported} AS reported,u.nick,u.year,u.gender,u.area,u.memo`;

export function newsService(db,safety,notifications={}) {
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const allowedAuthor=(alias='u')=>`${alias}.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM restrictions x WHERE x.identity=${alias}.identity AND x.until>?)
    AND NOT EXISTS(SELECT 1 FROM blocks x WHERE (x.owner=? AND x.peer=${alias}.id) OR (x.owner=${alias}.id AND x.peer=?))`;
  function id(value) {
    const number=typeof value==='string' && /^\d+$/.test(value)?Number(value):value;
    if(!Number.isSafeInteger(number)||number<1)reject(400,'소식 항목을 확인해 주세요.');
    return number;
  }
  function cursor(value) {
    if(value===null||value===undefined)return [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER];
    if(typeof value!=='string'||!/^\d+:\d+$/.test(value))reject(400,'소식 목록 범위를 확인해 주세요.');
    const values=value.split(':').map(Number);
    if(values.some(number=>!Number.isSafeInteger(number)||number<1))reject(400,'소식 목록 범위를 확인해 주세요.');
    return values;
  }
  function postRow(member,post,{admin=false,visible=false}={}) {
    const row=get(`SELECT ${postColumns} FROM news_posts n JOIN members u ON u.id=n.author WHERE n.id=?`,id(post));
    if(!row || row.created+newsRetentionTTL<=Date.now())reject(404,'소식을 찾을 수 없어요.');
    if(!admin) {
      if(row.retired_at!==null || row.created+newsPublicTTL<=Date.now() || row.state!=='approved' || !row.hasPhoto)
        reject(404,'공개 중인 소식을 찾을 수 없어요.');
      if(row.author!==member)safety.pairAllowed(member,row.author);
      if(visible && row.reported)reject(403,'신고 처리 중인 소식이에요.');
    }
    return row;
  }
  function countComments(post,member,admin) {
    if(admin)return get('SELECT COUNT(*) AS n FROM news_comments WHERE post=?',post).n;
    return get(`SELECT COUNT(*) AS n FROM news_comments c JOIN members u ON u.id=c.author
      WHERE c.post=? AND c.deleted_at IS NULL AND c.state='approved' AND ${allowedAuthor()}`,
      post,Date.now(),member,member).n;
  }
  function item(row,member,admin=false) {
    const publicUntil=row.created+newsPublicTTL,expiresAt=row.created+newsRetentionTTL;
    const visibility=row.state==='removed'?'removed':row.retired_at!==null?'retired':
      publicUntil<=Date.now()?'expired':row.reported?'reported':'visible';
    const author={id:row.author,nick:row.nick,area:row.area};
    if(admin)Object.assign(author,{year:row.year,gender:row.gender,memo:row.memo});
    return {id:row.id,created:row.created,publicUntil,expiresAt,mine:row.author===member,visibility,
      viewable:Number(Boolean(row.hasPhoto && (admin || visibility==='visible'))),author,
      likeCount:get('SELECT COUNT(*) AS n FROM news_likes WHERE post=?',row.id).n,
      liked:Boolean(member && get('SELECT 1 FROM news_likes WHERE post=? AND member=?',row.id,member)),
      commentCount:countComments(row.id,member,admin),
      ...(admin?{retiredAt:row.retired_at,retiredReason:row.retired_reason}:{})};
  }
  function feed(member,{area=null,before=null,admin=false}={}) {
    const [created,entry]=cursor(before),now=Date.now();
    const publicFilter=admin?'':`AND n.retired_at IS NULL AND n.state='approved' AND n.photo IS NOT NULL AND ${allowedAuthor()}`;
    const rows=all(`SELECT ${postColumns} FROM news_posts n JOIN members u ON u.id=n.author
      WHERE n.created+?>? AND (? IS NULL OR u.area=?) ${publicFilter}
      AND (n.created<? OR (n.created=? AND n.id<?)) ORDER BY n.created DESC,n.id DESC LIMIT ?`,
      admin?newsRetentionTTL:newsPublicTTL,now,area,area,...(admin?[]:[now,member,member]),created,created,entry,pageSize+1);
    const selected=rows.slice(0,pageSize),last=selected.at(-1);
    return {items:selected.map(row=>item(row,member,admin)),nextCursor:rows.length>pageSize?last.created+':'+last.id:null};
  }
  function mine(member) {
    const row=get(`SELECT ${postColumns} FROM news_posts n JOIN members u ON u.id=n.author
      WHERE n.author=? AND n.retired_at IS NULL AND n.state='approved' AND n.photo IS NOT NULL AND n.created+?>?`,member,newsPublicTTL,Date.now());
    return {item:row?item(row,member):null};
  }
  function upload(member,value) {
    if(typeof value!=='string')reject(400,'1.5MB 이하 JPEG 사진을 선택해 주세요.');
    const bytes=Buffer.from(value,'base64');
    if(bytes.length<4 || bytes.length>photoLimit || bytes.readUInt16BE(0)!==0xffd8 || bytes.readUInt16BE(bytes.length-2)!==0xffd9)
      reject(400,'1.5MB 이하 JPEG 사진을 선택해 주세요.');
    return transaction(db,()=>{
      const now=Date.now();
      run("UPDATE news_posts SET retired_at=?,retired_reason='replaced' WHERE author=? AND retired_at IS NULL",now,member);
      const inserted=run('INSERT INTO news_posts(author,created,photo) VALUES(?,?,?)',member,now,bytes);
      return {item:item(postRow(member,Number(inserted.lastInsertRowid)),member)};
    });
  }
  function remove(member,post,confirm) {
    if(confirm!==true)reject(400,'소식 삭제를 확인해 주세요.');
    return transaction(db,()=>{
      const row=postRow(null,post,{admin:true});
      if(row.author!==member)reject(404,'내가 올린 소식을 찾을 수 없어요.');
      run("UPDATE news_posts SET retired_at=?,retired_reason='deleted' WHERE id=? AND retired_at IS NULL",Date.now(),row.id);
      return {deleted:true};
    });
  }
  function photo(member,post,admin=false) {
    const row=postRow(member,post,{admin,visible:true});
    const found=get('SELECT photo FROM news_posts WHERE id=?',row.id);
    if(!found?.photo)reject(410,'보관 중인 소식 사진이 없어요.');
    return Buffer.from(found.photo);
  }
  function like(member,post,liked) {
    if(typeof liked!=='boolean')reject(400,'좋아요 상태를 확인해 주세요.');
    return transaction(db,()=>{
      const row=postRow(member,post,{visible:true});
      if(liked) {
        const inserted=run('INSERT OR IGNORE INTO news_likes VALUES(?,?,?)',row.id,member,Date.now());
        if(inserted.changes)notifications.enqueueNews?.({post:row.id,actor:member,kind:'like'});
      } else {
        run('DELETE FROM news_likes WHERE post=? AND member=?',row.id,member);
        notifications.cancelNewsLike?.(row.id,member);
      }
      return {liked,likeCount:get('SELECT COUNT(*) AS n FROM news_likes WHERE post=?',row.id).n};
    });
  }
  function commentItem(row,member,expiresAt,admin=false) {
    const visibility=row.state==='removed'?'removed':row.deleted_at!==null?'deleted':row.reported?'reported':'visible';
    const result={id:row.id,body:admin||visibility==='visible'?row.body:null,created:row.created,
      mine:row.author===member,visibility,expiresAt};
    if(admin)Object.assign(result,{author:{id:row.author,nick:row.nick,area:row.area},deletedAt:row.deleted_at});
    return result;
  }
  function comments(member,post,{before=null,admin=false}={}) {
    const row=postRow(member,post,{admin,visible:!admin});
    const cursor=before===null?Number.MAX_SAFE_INTEGER:id(before);
    const filtered=admin?'':`AND c.deleted_at IS NULL AND c.state='approved' AND ${allowedAuthor()}`;
    const rows=all(`SELECT c.*,u.nick,u.area,${commentReported} AS reported
      FROM news_comments c JOIN members u ON u.id=c.author WHERE c.post=? AND c.id<? ${filtered}
      ORDER BY c.id DESC LIMIT ?`,row.id,cursor,...(admin?[]:[Date.now(),member,member]),commentPageSize+1);
    const selected=rows.slice(0,commentPageSize),nextCursor=rows.length>commentPageSize?selected.at(-1).id:null;
    return {items:selected.reverse().map(comment=>commentItem(comment,member,row.created+newsRetentionTTL,admin)),nextCursor};
  }
  function comment(member,post,value) {
    if(typeof value!=='string'||value.trim().length<1||value.trim().length>2000)reject(400,'댓글을 1~2000자로 입력해 주세요.');
    const body=value.trim();checkText(body);
    return transaction(db,()=>{
      const row=postRow(member,post,{visible:true});
      const inserted=run('INSERT INTO news_comments(post,author,created,body) VALUES(?,?,?,?)',row.id,member,Date.now(),body);
      notifications.enqueueNews?.({post:row.id,actor:member,kind:'comment',comment:Number(inserted.lastInsertRowid)});
      const saved=get('SELECT *,0 AS reported FROM news_comments WHERE id=?',inserted.lastInsertRowid);
      return {item:commentItem(saved,member,row.created+newsRetentionTTL)};
    });
  }
  function removeComment(member,comment,confirm) {
    if(confirm!==true)reject(400,'댓글 삭제를 확인해 주세요.');
    return transaction(db,()=>{
      const row=get('SELECT * FROM news_comments WHERE id=? AND author=?',id(comment),member);
      if(!row)reject(404,'내가 작성한 댓글을 찾을 수 없어요.');
      postRow(null,row.post,{admin:true});
      run('UPDATE news_comments SET deleted_at=COALESCE(deleted_at,?) WHERE id=?',Date.now(),row.id);
      return {deleted:true};
    });
  }
  function report(member,b) {
    if(!['post','comment'].includes(b.kind) || !reasons.includes(b.reason))reject(400,'신고 대상과 사유를 확인해 주세요.');
    return transaction(db,()=>{
      let post,comment=null,target;
      if(b.kind==='post') {
        const row=postRow(member,b.id);post=row.id;target=row.author;
      } else {
        const row=get('SELECT * FROM news_comments WHERE id=?',id(b.id));
        if(!row || row.deleted_at!==null || row.state!=='approved')reject(404,'신고할 댓글을 찾을 수 없어요.');
        postRow(member,row.post);post=row.post;comment=row.id;target=row.author;
        if(member!==target)safety.pairAllowed(member,target);
      }
      if(member===target)reject(404,'신고할 소식 항목을 찾을 수 없어요.');
      const content='news-'+b.kind+':'+(comment??post);
      run(`INSERT OR IGNORE INTO news_reports(reporter,target,post,comment,kind,reason,created,content)
        VALUES(?,?,?,?,?,?,?,?)`,member,target,post,comment,b.kind,b.reason,Date.now(),content);
      return {ok:true};
    });
  }
  function reports() {
    const rows=all(`SELECT r.*,n.created AS posted,n.retired_at,n.photo IS NOT NULL AS viewable,
      c.body,u.nick,u.area,v.nick AS reporterNick FROM news_reports r
      JOIN news_posts n ON n.id=r.post LEFT JOIN news_comments c ON c.id=r.comment
      JOIN members u ON u.id=r.target JOIN members v ON v.id=r.reporter
      WHERE r.status='open' AND n.created+?>? ORDER BY r.created,r.id LIMIT 100`,newsRetentionTTL,Date.now());
    return {items:rows.map(row=>({id:row.id,kind:row.kind,postId:row.post,commentId:row.comment,
      reason:row.reason,created:row.created,expiresAt:row.posted+newsRetentionTTL,publicUntil:row.posted+newsPublicTTL,
      retiredAt:row.retired_at,reporter:{id:row.reporter,nick:row.reporterNick},author:{id:row.target,nick:row.nick,area:row.area},
      excerpt:row.comment===null?null:row.body,viewable:row.viewable}))};
  }
  function decision(report,action) {
    if(!['accept','dismiss'].includes(action))reject(400,'처리 방법을 선택해 주세요.');
    return transaction(db,()=>{
      const row=get(`SELECT r.*,n.created AS posted,m.identity FROM news_reports r
        JOIN news_posts n ON n.id=r.post JOIN members m ON m.id=r.target WHERE r.id=?`,id(report));
      if(!row)reject(404,'소식 신고를 찾을 수 없어요.');
      if(row.status===action)return {ok:true};
      if(row.status!=='open')reject(409,'이미 처리된 신고예요.');
      if(row.posted+newsRetentionTTL<=Date.now())reject(409,'소식 보관 기간이 지나 처리할 수 없어요.');
      if(action==='accept') {
        safety.penalize(row.identity,row.content);
        if(row.kind==='post')run("UPDATE news_posts SET state='removed',retired_at=COALESCE(retired_at,?),retired_reason=COALESCE(retired_reason,'removed') WHERE id=?",Date.now(),row.post);
        else run("UPDATE news_comments SET state='removed' WHERE id=?",row.comment);
        // News originals remain administrator-only until the parent's original
        // 24-hour deadline. Member withdrawal still cascades them immediately.
        run("UPDATE news_reports SET status='accept' WHERE content=? AND status='open'",row.content);
      } else run("UPDATE news_reports SET status='dismiss' WHERE id=?",row.id);
      return {ok:true};
    });
  }
  return {feed,mine,upload,remove,photo,like,comments,comment,removeComment,report,reports,decision,
    detail(member,post,admin=false){return {item:item(postRow(member,post,{admin}),member,admin)};}};
}
