import { reject } from './providers.mjs';
import { hour, messageTTL, messageLiveSQL, transaction, closeRoom } from './store.mjs';
import { policyVersion, reasons } from './public/rules.js';
import { createHash } from 'node:crypto';

const restrictedPhrases = [
  /(?:조건만남|조건만남구함|조건녀구함|조건남구함|원조교제|성매매알선|유료성관계|몸캠모집)/,
  /(?:누드|알몸|나체|성기|가슴|야한)(?:사진|영상|인증샷)(?:좀)?(?:보내|보여|교환|판매|팔아|구매|구함|올려)/,
  /(?:아청물|아동성착취물|불법촬영물|몰카영상|리벤지포르노)(?:공유|구매|교환|판매|팝니다|삽니다|보내)/,
  /(?:야동|포르노)(?:사이트|링크|공유|교환|보내)|(?:폰섹|섹스파트너|섹스할래|섹스하자)/,
  /(?:sendnudes|trad[e]?nudes|pornhubcom|xvideoscom)/
];
export function checkText(value) {
  const normalized=value.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{Cf}\p{S}]+/gu,'');
  if(restrictedPhrases.some(rule=>rule.test(normalized)))
    reject(422,'이 표현은 이용규칙에 따라 등록할 수 없어요. 피해 신고는 신고 메뉴를 이용해 주세요.');
}

export function moderation(db) {
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  function bump(room) {
    run('INSERT INTO room_changes VALUES(?,1) ON CONFLICT(room) DO UPDATE SET version=version+1',room);
  }
  function restricted(identity) {
    return get('SELECT until FROM restrictions WHERE identity=? AND until>?',identity,Date.now())?.until||0;
  }
  function penalty(identity) {
    const totalStrikes=get('SELECT COUNT(*) AS n FROM penalty_events WHERE identity=?',identity).n;
    return {strikes:totalStrikes%3,totalStrikes,restrictedUntil:restricted(identity)};
  }
  // Call inside the surrounding content-review transaction.
  function penalize(identity,content) {
    if(get('SELECT 1 FROM penalty_contents WHERE content=?',content))return false;
    const added=run('INSERT OR IGNORE INTO penalty_events VALUES(?,?,?)',content,identity,Date.now());
    if(!added.changes)return false;
    run('INSERT OR IGNORE INTO penalty_contents VALUES(?,?)',content,content);
    if(penalty(identity).totalStrikes%3===0)
      run('INSERT INTO restrictions VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET until=excluded.until',identity,Math.max(Date.now(),restricted(identity))+24*hour);
    return true;
  }
  function profileContent(id) {
    const m=get('SELECT nick,memo FROM members WHERE id=?',id);
    return 'profile:'+id+':'+createHash('sha256').update(JSON.stringify(m)).digest('hex');
  }
  function memberStage(id) {
    const m=get('SELECT identity FROM members WHERE id=? AND deleted_at IS NULL',id);
    if(!m) return 'gate';
    if(restricted(m.identity))return 'restricted';
    return get('SELECT 1 FROM acceptances WHERE member=? AND version=?',id,policyVersion)?'member':'policy';
  }
  function accept(id,version) {
    if(version!==policyVersion)reject(400,'현재 이용규칙을 확인하고 동의해 주세요.');
    run('INSERT OR REPLACE INTO acceptances VALUES(?,?,?)',id,version,Date.now());
  }
  function pairAllowed(id,peer) {
    const m=get('SELECT identity FROM members WHERE id=? AND deleted_at IS NULL',peer);
    if(!m || restricted(m.identity) || get('SELECT 1 FROM blocks WHERE (owner=? AND peer=?) OR (owner=? AND peer=?)',id,peer,peer,id))
      reject(404,'이 대화를 이용할 수 없어요.');
  }
  function setBlock(id,peer,remove) {
    if(typeof peer!=='string' || id===peer || !get('SELECT 1 FROM members WHERE id=? AND deleted_at IS NULL',peer))reject(404,'회원을 찾을 수 없어요.');
    return transaction(db,()=>{
      if(remove){run('DELETE FROM blocks WHERE owner=? AND peer=?',id,peer);return null;}
      run('INSERT OR IGNORE INTO blocks VALUES(?,?)',id,peer);
      const room=get('SELECT id FROM rooms WHERE (a=? AND b=?) OR (a=? AND b=?)',id,peer,peer,id);
      return room && closeRoom(db,room.id,'blocked')?room.id:null;
    });
  }
  function report(reporter,b) {
    if(!reasons.includes(b.reason))reject(400,'신고 사유를 선택해 주세요.');
    if(b.kind==='conversation')return transaction(db,()=>{
      if(typeof b.room!=='string')reject(400,'신고할 대화방을 선택해 주세요.');
      const room=get('SELECT id,a,b FROM rooms WHERE id=? AND closed_at IS NULL',b.room);
      if(!room || (room.a!==reporter && room.b!==reporter))reject(404,'신고할 대화방을 찾을 수 없어요.');
      const peer=room.a===reporter?room.b:room.a;
      pairAllowed(reporter,peer);
      // A new message from the target creates a new reportable conversation.
      // Expiry, deletion and a review decision do not change this identity.
      const last=get('SELECT MAX(id) AS id FROM messages WHERE room=? AND author=?',room.id,peer).id;
      const content='conversation:'+room.id+':'+peer+':'+(last??0);
      if(get('SELECT 1 FROM reports WHERE reporter=? AND target=? AND content=?',reporter,peer,content))return null;
      const context=get(`SELECT m.id,m.body FROM messages m LEFT JOIN reviews v ON v.message=m.id
        WHERE m.room=? AND m.author=? AND m.deleted_at IS NULL AND m.expires IS NULL AND m.body IS NOT NULL
          AND m.sent+${messageTTL}>? AND (v.state IS NULL OR v.state='approved') ORDER BY m.id DESC LIMIT 1`,room.id,peer,Date.now());
      const inserted=run(`INSERT INTO reports(reporter,target,message,reason,created,content,room,context_message,conversation_excerpt)
        VALUES(?,?,NULL,?,?,?,?,?,?)`,reporter,peer,b.reason,Date.now(),content,room.id,context?.id??null,context?.body??null);
      // The fixed mapping is deliberately not extended when new photos arrive.
      run(`INSERT INTO report_messages(report,message) SELECT ?,m.id FROM messages m LEFT JOIN reviews v ON v.message=m.id
        WHERE m.room=? AND m.author=? AND m.deleted_at IS NULL AND m.photo IS NOT NULL
          AND m.expires>? AND m.sent+?>? AND (v.state IS NULL OR v.state IN ('approved','pending'))`,
        inserted.lastInsertRowid,room.id,peer,Date.now(),messageTTL,Date.now());
      run('UPDATE reports SET photo_count=(SELECT COUNT(*) FROM report_messages WHERE report=?) WHERE id=?',inserted.lastInsertRowid,inserted.lastInsertRowid);
      bump(room.id);return room.id;
    });
    let peer,room=null,message=null;
    if(b.kind==='message'){
      if(!Number.isSafeInteger(b.message))reject(400,'신고할 메시지를 선택해 주세요.');
      const m=get(`SELECT m.id,m.author,m.room,r.a,r.b FROM messages m JOIN rooms r ON m.room=r.id JOIN members p ON p.id=m.author
        WHERE m.id=? AND p.deleted_at IS NULL AND r.closed_at IS NULL AND m.sent+${messageTTL}>?`,b.message,Date.now());
      if(!m || (m.a!==reporter && m.b!==reporter) || m.author===reporter)reject(404,'신고할 메시지를 찾을 수 없어요.');
      peer=m.author;room=m.room;message=m.id;
    } else if(b.kind==='profile') {
      peer=b.peer;
      if(typeof peer!=='string' || peer===reporter || !get('SELECT 1 FROM members WHERE id=? AND deleted_at IS NULL',peer))reject(404,'프로필을 찾을 수 없어요.');
    } else reject(400,'신고 대상을 확인해 주세요.');
    return transaction(db,()=>{
      const content=message==null?profileContent(peer):'message:'+message;
      if(message==null) {
        if(typeof b.profileVersion!=='string' || !b.profileVersion)reject(400,'프로필을 새로 확인한 뒤 신고해 주세요.');
        if(b.profileVersion!==content)reject(409,'소개글이 변경됐어요. 프로필을 새로 확인한 뒤 신고해 주세요.');
      }
      const previous=get('SELECT id FROM reports WHERE reporter=? AND target=? AND content=?',reporter,peer,content);
      if(previous)return null;
      const snapshot=message==null?JSON.stringify(get('SELECT nick,area,memo FROM members WHERE id=?',peer)):null;
      run('INSERT INTO reports(reporter,target,message,reason,created,content,profile_snapshot) VALUES(?,?,?,?,?,?,?)',reporter,peer,message,b.reason,Date.now(),content,snapshot);
      if(room)bump(room);
      return room;
    });
  }
  function photoDecision(id,decision,onApproved) {
    reject(409,'사진은 바로 표시됩니다. 접수된 신고에서 승인 또는 거부해 주세요.');
  }
  function reportDecision(id,action) {
    if(!['dismiss','accept'].includes(action))reject(400,'처리 방법을 선택해 주세요.');
    return transaction(db,()=>{
      const r=get('SELECT r.*, m.identity FROM reports r JOIN members m ON m.id=r.target WHERE r.id=?',id);
      if(!r)reject(404,'신고를 찾을 수 없어요.');
      if(r.status===action)return null;
      if(r.status!=='open')reject(409,'이미 처리된 신고예요.');
      if(action==='accept' && r.room===null && r.message===null && !r.profile_snapshot)
        reject(409,'신고 당시 소개글 원문을 확인할 수 없어 승인할 수 없어요.');
      const content=r.content || (r.message==null?profileContent(r.target):'message:'+r.message);
      const photos=r.room===null?[]:all('SELECT message FROM report_messages WHERE report=? ORDER BY message',id).map(m=>m.message);
      const currentPhotos=r.room===null?[]:all(`SELECT m.id FROM report_messages rm JOIN messages m ON m.id=rm.message
        WHERE rm.report=? AND ${messageLiveSQL()} AND (m.photo IS NOT NULL OR EXISTS(
          SELECT 1 FROM penalty_contents WHERE content='message:'||m.id))`,id,Date.now()).map(m=>m.id);
      const contextCurrent=r.context_message!==null && Boolean(get(`SELECT 1 FROM messages m WHERE m.id=? AND m.sent+${messageTTL}>?`,r.context_message,Date.now()));
      if(action==='accept' && (r.message!==null && !get(`SELECT 1 FROM messages m WHERE m.id=? AND m.sent+${messageTTL}>?`,r.message,Date.now()) ||
        r.room!==null && (r.photo_count>0?currentPhotos.length===0:!contextCurrent)))
        reject(409,'보관 기간이 지났거나 확인할 수 있는 신고 원문이 없어 승인할 수 없어요.');
      if(action==='accept'){
        // An accepted group counts once, even if it contains many photos. An
        // individual report and overlapping groups share the same evidence keys.
        const evidence=r.room===null?[content]:r.photo_count>0?currentPhotos.map(message=>'message:'+message):
          [r.context_message===null?content:'message:'+r.context_message];
        if(evidence.some(key=>!get('SELECT 1 FROM penalty_contents WHERE content=?',key))) {
          const added=run('INSERT OR IGNORE INTO penalty_events VALUES(?,?,?)',content,r.identity,Date.now());
          if(added.changes) {
            for(const key of [...evidence,...(r.room!==null && contextCurrent?['message:'+r.context_message]:[])])
              run('INSERT OR IGNORE INTO penalty_contents VALUES(?,?)',key,content);
            if(penalty(r.identity).totalStrikes%3===0)
              run('INSERT INTO restrictions VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET until=excluded.until',r.identity,Math.max(Date.now(),restricted(r.identity))+24*hour);
          }
        }
        if(r.room!==null || r.message!==null) {
          const removedMessages=r.room===null?[r.message]:r.photo_count>0?photos:[r.context_message];
          for(const message of removedMessages) {
            run("INSERT OR REPLACE INTO reviews VALUES(?,'removed')",message);
            run('UPDATE messages SET photo=NULL,body=NULL WHERE id=?',message);
            run('UPDATE reports SET conversation_excerpt=NULL WHERE context_message=?',message);
          }
        }else if(content===profileContent(r.target)){
          run("UPDATE members SET nick='이용자',memo='운영자가 프로필 내용을 삭제했어요.' WHERE id=?",r.target);
        }
        run("UPDATE reports SET status='accept' WHERE status='open' AND (content=? OR (? IS NOT NULL AND message=?))",content,r.message,r.message);
      }else if(r.room!==null) {
        run("UPDATE reviews SET state='approved' WHERE state='pending' AND message IN (SELECT message FROM report_messages WHERE report=?)",id);
      }else if(r.message!=null){
        // A dismissed legacy report may still have a pre-moderation marker.
        run("UPDATE reviews SET state='approved' WHERE message=? AND state='pending'",r.message);
      }
      run('UPDATE reports SET status=?,content=? WHERE id=?',action,content,id);
      const room=r.room??(r.message===null?null:get('SELECT room FROM messages WHERE id=?',r.message).room);
      if(room)bump(room);
      return room;
    });
  }
  function queue() {
    return {
      photos:[],
      reports:all(`SELECT r.id,r.reason,r.created,r.message,r.reporter,r.profile_snapshot,r.room AS conversationRoom,r.photo_count,
        CASE WHEN ctx.sent+${messageTTL}>? THEN r.conversation_excerpt END AS conversation_excerpt,
        CASE WHEN r.room IS NULL THEN m.sent+${messageTTL} ELSE ctx.sent+${messageTTL} END AS excerptExpiresAt,
        m.sent+${messageTTL} AS expiresAt,u.id AS sender,u.nick,u.area,
        m.body AS excerpt,
        CASE WHEN m.photo IS NOT NULL AND ${messageLiveSQL()} AND NOT EXISTS(SELECT 1 FROM reviews v WHERE v.message=m.id AND v.state='removed') THEN m.id END AS photo,
        m.deleted_at AS deletedAt
        FROM reports r JOIN members u ON r.target=u.id LEFT JOIN messages m ON r.message=m.id LEFT JOIN messages ctx ON ctx.id=r.context_message
        WHERE r.status='open' AND (r.message IS NULL OR m.sent+${messageTTL}>?) ORDER BY r.created,r.id LIMIT 100`,Date.now(),Date.now(),Date.now()).map(({profile_snapshot,conversation_excerpt,photo_count,...report})=>{
          if(report.conversationRoom!==null) {
            const photos=all(`SELECT m.id,m.sent+${messageTTL} AS expires,m.deleted_at AS deletedAt,
              (m.photo IS NOT NULL AND ${messageLiveSQL()} AND (v.state IS NULL OR v.state!='removed')) AS viewable
              FROM report_messages rm JOIN messages m ON m.id=rm.message LEFT JOIN reviews v ON v.message=m.id
              WHERE rm.report=? ORDER BY m.id`,Date.now(),report.id);
            return {...report,excerpt:conversation_excerpt,photos,photoCount:photo_count};
          }
          if(report.message!==null)return report;
          const snapshot=profile_snapshot?JSON.parse(profile_snapshot):null;
          return {...report,...(snapshot?{nick:snapshot.nick,area:snapshot.area}:{}),
            excerpt:snapshot?.memo??'신고 당시 소개글 원문을 확인할 수 없어요.',profileSnapshotAvailable:Boolean(snapshot)};
        })
    };
  }
  return {restricted,penalty,penalize,memberStage,accept,pairAllowed,setBlock,report,queue,photoDecision,reportDecision,profileContent};
}
