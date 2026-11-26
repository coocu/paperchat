import { reject } from './providers.mjs';
import { hour, transaction } from './store.mjs';
import { policyVersion, reasons } from './public/rules.js';

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
  function memberStage(id) {
    const m=get('SELECT identity FROM members WHERE id=?',id);
    if(!m) return 'gate';
    if(restricted(m.identity))return 'restricted';
    if(!get('SELECT 1 FROM contacts WHERE member=?',id))return 'contact';
    return get('SELECT 1 FROM acceptances WHERE member=? AND version=?',id,policyVersion)?'member':'policy';
  }
  function accept(id,version) {
    if(version!==policyVersion)reject(400,'현재 이용규칙을 확인하고 동의해 주세요.');
    run('INSERT OR REPLACE INTO acceptances VALUES(?,?,?)',id,version,Date.now());
  }
  function pairAllowed(id,peer) {
    const m=get('SELECT identity FROM members WHERE id=?',peer);
    if(!m || restricted(m.identity) || get('SELECT 1 FROM blocks WHERE (owner=? AND peer=?) OR (owner=? AND peer=?)',id,peer,peer,id))
      reject(404,'이 대화를 이용할 수 없어요.');
  }
  function setBlock(id,peer,remove) {
    if(typeof peer!=='string' || id===peer || !get('SELECT 1 FROM members WHERE id=?',peer))reject(404,'회원을 찾을 수 없어요.');
    if(remove)run('DELETE FROM blocks WHERE owner=? AND peer=?',id,peer);
    else run('INSERT OR IGNORE INTO blocks VALUES(?,?)',id,peer);
  }
  function report(reporter,b) {
    if(!reasons.includes(b.reason))reject(400,'신고 사유를 선택해 주세요.');
    let peer,room=null,message=null;
    if(b.kind==='message'){
      if(!Number.isSafeInteger(b.message))reject(400,'신고할 메시지를 선택해 주세요.');
      const m=get('SELECT m.id,m.author,m.room,r.a,r.b FROM messages m JOIN rooms r ON m.room=r.id WHERE m.id=?',b.message);
      if(!m || (m.a!==reporter && m.b!==reporter) || m.author===reporter)reject(404,'신고할 메시지를 찾을 수 없어요.');
      peer=m.author;room=m.room;message=m.id;
    } else if(b.kind==='profile') {
      peer=b.peer;
      if(typeof peer!=='string' || peer===reporter || !get('SELECT 1 FROM members WHERE id=?',peer))reject(404,'프로필을 찾을 수 없어요.');
    } else reject(400,'신고 대상을 확인해 주세요.');
    transaction(db,()=>{
      const previous=get('SELECT id FROM reports WHERE reporter=? AND target=? AND message IS ?',reporter,peer,message);
      if(previous)return;
      run('INSERT INTO reports(reporter,target,message,reason,created) VALUES(?,?,?,?,?)',reporter,peer,message,b.reason,Date.now());
      if(room)bump(room);
    });
  }
  function photoDecision(id,decision,onApproved) {
    if(!['approve','reject'].includes(decision))reject(400,'검토 결과를 확인해 주세요.');
    transaction(db,()=>{
      const p=get("SELECT m.room FROM messages m JOIN reviews v ON v.message=m.id WHERE m.id=? AND v.state='pending' AND m.photo IS NOT NULL AND m.expires>?",id,Date.now());
      if(!p)reject(409,'이미 처리되었거나 보관 기간이 지났어요.');
      run('UPDATE reviews SET state=? WHERE message=?',decision==='approve'?'approved':'removed',id);
      if(decision==='reject')run('UPDATE messages SET photo=NULL WHERE id=?',id);
      if(decision==='approve')onApproved(id);
      bump(p.room);
    });
  }
  function reportDecision(id,action) {
    if(!['dismiss','remove','suspend'].includes(action))reject(400,'처리 방법을 선택해 주세요.');
    transaction(db,()=>{
      const r=get("SELECT r.*, m.identity FROM reports r JOIN members m ON m.id=r.target WHERE r.id=? AND r.status='open'",id);
      if(!r)reject(409,'이미 처리된 신고예요.');
      if(action!=='dismiss'){
        if(r.message!=null){
          run("INSERT OR REPLACE INTO reviews VALUES(?,'removed')",r.message);
          run('UPDATE messages SET photo=NULL,body=NULL WHERE id=?',r.message);
        }else{
          run("UPDATE members SET nick='이용자',memo='운영자가 프로필 내용을 삭제했어요.' WHERE id=?",r.target);
        }
      }
      if(action==='suspend')run('INSERT OR REPLACE INTO restrictions VALUES(?,?)',r.identity,Date.now()+30*24*hour);
      run('UPDATE reports SET status=? WHERE id=?',action,id);
      if(r.message!=null)bump(get('SELECT room FROM messages WHERE id=?',r.message).room);
    });
  }
  function queue() {
    return {
      photos:all("SELECT m.id,m.sent,m.expires,u.id AS sender,u.nick,u.area FROM messages m JOIN reviews v ON v.message=m.id JOIN members u ON u.id=m.author WHERE v.state='pending' AND m.expires>? AND m.photo IS NOT NULL ORDER BY m.sent,m.id LIMIT 100",Date.now()),
      reports:all(`SELECT r.id,r.reason,r.created,r.message,r.reporter,u.id AS sender,u.nick,u.area,
        CASE WHEN r.message IS NULL THEN u.memo ELSE m.body END AS excerpt,
        CASE WHEN m.photo IS NOT NULL AND m.expires>? THEN m.id END AS photo
        FROM reports r JOIN members u ON r.target=u.id LEFT JOIN messages m ON r.message=m.id
        WHERE r.status='open' ORDER BY r.created,r.id LIMIT 100`,Date.now())
    };
  }
  return {restricted,memberStage,accept,pairAllowed,setBlock,report,queue,photoDecision,reportDecision};
}
