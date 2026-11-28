import { randomUUID } from 'node:crypto';
import { transaction, openMessageReportSQL, messageLiveSQL } from './store.mjs';
import { reject } from './providers.mjs';
import { webSubscription } from './web-push.mjs';
import { newsPublicTTL } from './news.mjs';

export function pushQueue(db, provider, safety) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      platform TEXT NOT NULL, token TEXT NOT NULL, UNIQUE(platform,token), UNIQUE(session,platform));
    CREATE TABLE IF NOT EXISTS push_jobs (
      id TEXT PRIMARY KEY, message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      device TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
      due INTEGER NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, UNIQUE(message,device));
    CREATE INDEX IF NOT EXISTS push_due ON push_jobs(due);
    CREATE TABLE IF NOT EXISTS news_push_targets(
      event TEXT NOT NULL REFERENCES news_push_events(id) ON DELETE CASCADE,
      device TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,PRIMARY KEY(event,device));
    CREATE TABLE IF NOT EXISTS news_push_jobs(id TEXT PRIMARY KEY,
      event TEXT NOT NULL REFERENCES news_push_events(id) ON DELETE CASCADE,
      device TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
      due INTEGER NOT NULL,expires INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0,UNIQUE(event,device));
    CREATE INDEX IF NOT EXISTS news_push_due ON news_push_jobs(due);
  `);
  const run = (sql,...a) => db.prepare(sql).run(...a);
  const get = (sql,...a) => db.prepare(sql).get(...a);
  let running, closed = false;

  function bind(session, platform, token) {
    let subscription;
    if(platform==='web') {
      subscription=webSubscription(token);
      token=JSON.stringify(subscription);
    }
    const valid = platform==='android' ? /^[\w:-]{20,4096}$/ : /^(?:[\da-f]{2}){16,256}$/;
    if (!['android','ios-dev','ios-prod','web'].includes(platform) || typeof token!=='string' || (platform!=='web' && !valid.test(token)))
      reject(400,'알림 기기 정보를 확인해 주세요.');
    transaction(db,()=>{
      if (get('SELECT 1 FROM push_devices WHERE session=? AND platform=? AND token=?',session,platform,token)) return;
      if(subscription)run("DELETE FROM push_devices WHERE platform='web' AND json_extract(token,'$.endpoint')=?",subscription.endpoint);
      run('DELETE FROM push_devices WHERE platform=? AND (session=? OR token=?)',platform,session,token);
      run('INSERT INTO push_devices VALUES(?,?,?,?)',randomUUID(),session,platform,token);
    });
    return {configured:provider.enabled(platform)};
  }
  function mayNotify(session,device,message) {
    const now=Date.now();
    const row=get(`SELECT s.member,m.author FROM push_devices d JOIN sessions s ON s.id=d.session
      JOIN messages m ON m.id=? JOIN rooms r ON r.id=m.room LEFT JOIN reviews v ON v.message=m.id
      WHERE d.id=? AND d.session=? AND d.platform='web' AND s.kind='member' AND s.expires>?
      AND s.member=CASE WHEN r.a=m.author THEN r.b ELSE r.a END
      AND r.closed_at IS NULL AND m.deleted_at IS NULL
      AND m.id>COALESCE((SELECT through FROM room_reads WHERE room=r.id AND member=s.member),0)
      AND ${messageLiveSQL()} AND ((m.body IS NOT NULL AND v.state IS NULL) OR (v.state='approved' AND m.photo IS NOT NULL))
      AND NOT ${openMessageReportSQL('m.id')}`,message,device,session,now,now);
    if(!row || safety.memberStage(row.member)!=='member' || safety.memberStage(row.author)!=='member')return false;
    try{safety.pairAllowed(row.member,row.author);return true;}catch{return false;}
  }
  function enqueue(message) {
    const now=Date.now();
    const devices=db.prepare(`SELECT d.id FROM messages m JOIN rooms r ON r.id=m.room
      JOIN sessions s ON s.member=CASE WHEN r.a=m.author THEN r.b ELSE r.a END
      JOIN push_devices d ON d.session=s.id WHERE m.id=? AND s.expires>? AND ${messageLiveSQL()} AND r.closed_at IS NULL AND m.deleted_at IS NULL`).all(message,now,now);
    for(const d of devices) run('INSERT OR IGNORE INTO push_jobs(id,message,device,due,expires) VALUES(?,?,?,?,?)',
      randomUUID(),message,d.id,now,now+600000);
  }
  // Called by the reaction's surrounding transaction. A cancelled like token
  // stays until the post's public deadline, so toggling never republishes it.
  function enqueueNews({post,actor,kind,comment=null}) {
    if(!['like','comment'].includes(kind))return;
    const now=Date.now(),row=get(`SELECT n.author,n.created FROM news_posts n
      WHERE n.id=? AND n.retired_at IS NULL AND n.state='approved' AND n.photo IS NOT NULL AND n.created+?>?
      AND NOT EXISTS(SELECT 1 FROM news_reports r WHERE r.post=n.id AND r.comment IS NULL AND r.status='open')`,post,newsPublicTTL,now);
    if(!row || row.author===actor || safety.memberStage(actor)!=='member' || safety.memberStage(row.author)!=='member')return;
    try{safety.pairAllowed(actor,row.author);}catch{return;}
    if(kind==='like' && !get('SELECT 1 FROM news_likes WHERE post=? AND member=?',post,actor))return;
    if(kind==='comment' && !get(`SELECT 1 FROM news_comments c WHERE c.id=? AND c.post=? AND c.author=?
      AND c.deleted_at IS NULL AND c.state='approved' AND c.body IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM news_reports r WHERE r.comment=c.id AND r.status='open')`,comment,post,actor))return;
    const event=randomUUID(),expires=row.created+newsPublicTTL;
    const inserted=run(`INSERT OR IGNORE INTO news_push_events(id,post,actor,kind,comment,created,expires)
      VALUES(?,?,?,?,?,?,?)`,event,post,actor,kind,kind==='comment'?comment:null,now,expires);
    if(!inserted.changes)return;
    const devices=db.prepare(`SELECT d.id FROM push_devices d JOIN sessions s ON s.id=d.session
      WHERE s.member=? AND s.kind='member' AND s.expires>?`).all(row.author,now);
    for(const device of devices) {
      run('INSERT INTO news_push_targets VALUES(?,?)',event,device.id);
      run('INSERT INTO news_push_jobs(id,event,device,due,expires) VALUES(?,?,?,?,?)',randomUUID(),event,device.id,now,Math.min(now+600000,expires));
    }
  }
  function cancelNewsLike(post,actor) {
    run("UPDATE news_push_events SET cancelled=1 WHERE post=? AND actor=? AND kind='like'",post,actor);
    run("DELETE FROM news_push_jobs WHERE event IN (SELECT id FROM news_push_events WHERE post=? AND actor=? AND kind='like')",post,actor);
  }
  function newsEligible(event,device,session,webOnly=false) {
    if(closed)return null;
    const now=Date.now();
    const row=get(`SELECT e.post,e.kind,e.actor,n.author AS member
      FROM news_push_events e JOIN news_posts n ON n.id=e.post
      JOIN news_push_targets t ON t.event=e.id JOIN push_devices d ON d.id=t.device
      JOIN sessions s ON s.id=d.session LEFT JOIN news_comments c ON c.id=e.comment
      WHERE e.id=? AND d.id=? AND s.id=? AND s.kind='member' AND s.member=n.author AND s.expires>?
      ${webOnly?"AND d.platform='web'":''}
      AND e.cancelled=0 AND e.expires>? AND e.created+600000>? AND n.created+${newsPublicTTL}>?
      AND n.author<>e.actor AND n.retired_at IS NULL AND n.state='approved' AND n.photo IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM news_reports r WHERE r.post=n.id AND r.comment IS NULL AND r.status='open')
      AND ((e.kind='like' AND EXISTS(SELECT 1 FROM news_likes l WHERE l.post=n.id AND l.member=e.actor))
        OR (e.kind='comment' AND c.post=n.id AND c.author=e.actor AND c.deleted_at IS NULL AND c.state='approved' AND c.body IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM news_reports r WHERE r.comment=c.id AND r.status='open')))`,event,device,session,now,now,now,now);
    if(!row || safety.memberStage(row.member)!=='member' || safety.memberStage(row.actor)!=='member')return null;
    try{safety.pairAllowed(row.member,row.actor);return row;}catch{return null;}
  }
  function mayNotifyNews(session,device,event,post) {
    const row=newsEligible(event,device,session,true);
    return row && row.post===post?{notify:true,postId:row.post,newsType:row.kind}:{notify:false};
  }
  function newsDeliverable(id) {
    const job=get(`SELECT j.event,j.device,d.session FROM news_push_jobs j JOIN push_devices d ON d.id=j.device
      WHERE j.id=? AND j.expires>?`,id,Date.now());
    return Boolean(job && newsEligible(job.event,job.device,job.session));
  }
  function deliverable(id) {
    if (closed) return false;
    const now=Date.now();
    const row=get(`SELECT s.member,m.author FROM push_jobs j JOIN push_devices d ON d.id=j.device
      JOIN sessions s ON s.id=d.session JOIN messages m ON m.id=j.message JOIN rooms r ON r.id=m.room
      LEFT JOIN reviews v ON v.message=m.id WHERE j.id=? AND j.expires>? AND s.expires>?
      AND m.deleted_at IS NULL AND r.closed_at IS NULL
      AND ${messageLiveSQL()} AND ((m.body IS NOT NULL AND v.state IS NULL) OR (v.state='approved' AND m.photo IS NOT NULL))
      AND NOT ${openMessageReportSQL('m.id')}`,id,now,now,now);
    if (!row || safety.memberStage(row.member)!=='member' || safety.memberStage(row.author)!=='member') return false;
    try { safety.pairAllowed(row.member,row.author); return true; } catch { return false; }
  }
  async function deliver(job) {
    try {
      const valid=()=>deliverable(job.id);
      const allowed=()=>valid() && (job.platform!=='web' || mayNotify(job.session,job.device,job.message));
      const result=allowed() && provider.enabled(job.platform) ? await provider.send(job,job.id,allowed) : 'skip';
      if (closed) return;
      if (result==='invalid') run('DELETE FROM push_devices WHERE id=?',job.device);
      run('DELETE FROM push_jobs WHERE id=?',job.id);
    } catch(e) {
      if (closed) return;
      if (job.tries===0) console.warn('푸시 전송 재시도',job.platform, e.message?.match(/^(FCM|APNs) [A-Za-z0-9 ]{1,60}$/)?.[0] || '연결 오류');
      run('UPDATE push_jobs SET tries=tries+1,due=? WHERE id=?',Date.now()+Math.min(120000,5000*2**job.tries),job.id);
    }
  }
  async function deliverNews(job) {
    try {
      const allowed=()=>newsDeliverable(job.id);
      const result=allowed() && provider.enabled(job.platform)?await provider.send(job,job.event,allowed):'skip';
      if(closed)return;
      if(result==='invalid')run('DELETE FROM push_devices WHERE id=?',job.device);
      run('DELETE FROM news_push_jobs WHERE id=?',job.id);
    } catch(e) {
      if(closed)return;
      if(job.tries===0)console.warn('소식 푸시 전송 재시도',job.platform,e.message?.match(/^(FCM|APNs) [A-Za-z0-9 ]{1,60}$/)?.[0]||'연결 오류');
      run('UPDATE news_push_jobs SET tries=tries+1,due=? WHERE id=?',Date.now()+Math.min(120000,5000*2**job.tries),job.id);
    }
  }
  async function drain() {
    if (closed) return;
    run('DELETE FROM push_jobs WHERE expires<=?',Date.now());
    run('DELETE FROM news_push_jobs WHERE expires<=?',Date.now());
    const jobs=db.prepare(`SELECT j.*,d.token,d.platform,d.session FROM push_jobs j JOIN push_devices d ON d.id=j.device
      WHERE j.due<=? ORDER BY j.due,j.rowid LIMIT 12`).all(Date.now());
    const newsJobs=db.prepare(`SELECT j.*,d.token,d.platform,d.session,'news' AS kind,e.post AS postId,e.kind AS newsType
      FROM news_push_jobs j JOIN push_devices d ON d.id=j.device JOIN news_push_events e ON e.id=j.event
      WHERE j.due<=? ORDER BY j.due,j.rowid LIMIT 12`).all(Date.now());
    await Promise.all([...jobs.map(deliver),...newsJobs.map(deliverNews)]);
  }
  function flush() {
    running ||= drain().finally(()=>{running=null;});
    return running;
  }
  return {bind,enqueue,enqueueNews,cancelNewsLike,flush,mayNotify,mayNotifyNews,
    unbind(session){run("DELETE FROM push_devices WHERE session=? AND platform='web'",session);},close(){closed=true;}};
}
