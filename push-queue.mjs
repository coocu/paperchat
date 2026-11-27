import { randomUUID } from 'node:crypto';
import { transaction, openMessageReportSQL, messageLiveSQL } from './store.mjs';
import { reject } from './providers.mjs';
import { webSubscription } from './web-push.mjs';

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
  async function drain() {
    if (closed) return;
    run('DELETE FROM push_jobs WHERE expires<=?',Date.now());
    const jobs=db.prepare(`SELECT j.*,d.token,d.platform,d.session FROM push_jobs j JOIN push_devices d ON d.id=j.device
      WHERE j.due<=? ORDER BY j.due,j.rowid LIMIT 12`).all(Date.now());
    await Promise.all(jobs.map(deliver));
  }
  function flush() {
    running ||= drain().finally(()=>{running=null;});
    return running;
  }
  return {bind,enqueue,flush,mayNotify,unbind(session){run("DELETE FROM push_devices WHERE session=? AND platform='web'",session);},close(){closed=true;}};
}
