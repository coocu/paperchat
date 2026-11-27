import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { migrateMemberAreas } from './regions.mjs';

export const hour = 3600_000;
export const tables = ['signup_gates','used_invites','account_devices','account_keys','push_jobs','push_devices','session_presence','member_activity','admin_session_proofs','departures','pending_contacts','contacts','report_messages','reports','penalty_contents','penalty_events','reviews','room_reads','room_changes','blocks','acceptances','restrictions','messages','rooms','sessions','members','cooldowns','settings','attempts'];
// Only pass a source-controlled SQL column expression, never request input.
export function openMessageReportSQL(message) {
  return `(EXISTS(SELECT 1 FROM reports f WHERE f.message=${message} AND f.status='open')
    OR EXISTS(SELECT 1 FROM report_messages rm JOIN reports f ON f.id=rm.report
      WHERE rm.message=${message} AND f.status='open'))`;
}
export function openStore(dir) {
  mkdirSync(dir, {recursive:true, mode:0o700});
  const db = new DatabaseSync(join(dir,'chat.sqlite'));
  db.exec(`
    PRAGMA auto_vacuum=FULL;
    PRAGMA secure_delete=ON;
    PRAGMA journal_mode=DELETE;
    PRAGMA temp_store=MEMORY;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, nick TEXT NOT NULL,
      year INTEGER NOT NULL, gender TEXT NOT NULL, area TEXT NOT NULL, memo TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL,
      member TEXT REFERENCES members(id) ON DELETE CASCADE, challenge TEXT,
      identity TEXT, year INTEGER, gender TEXT, nick TEXT
    );
    CREATE TABLE IF NOT EXISTS cooldowns (identity TEXT PRIMARY KEY, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES members ON DELETE CASCADE,
      b TEXT NOT NULL REFERENCES members ON DELETE CASCADE, UNIQUE(a,b)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms ON DELETE CASCADE,
      author TEXT NOT NULL REFERENCES members ON DELETE CASCADE, sent INTEGER NOT NULL,
      body TEXT, photo BLOB, expires INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_by_room ON messages(room,id);
    CREATE INDEX IF NOT EXISTS photo_expiry ON messages(expires) WHERE photo IS NOT NULL;
    CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, until INTEGER NOT NULL);
  `);
  transaction(db,()=>db.exec(`
    CREATE TABLE IF NOT EXISTS departures(id TEXT PRIMARY KEY,nick TEXT NOT NULL,withdrawn INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS departure_expiry ON departures(expires);
    CREATE TABLE IF NOT EXISTS service_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS used_invites(proof TEXT PRIMARY KEY,pending_device TEXT,pending_until INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS pending_invite_device ON used_invites(pending_device) WHERE pending_device IS NOT NULL;
    CREATE TABLE IF NOT EXISTS signup_gates(device TEXT PRIMARY KEY,proof TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_keys(member TEXT PRIMARY KEY REFERENCES members ON DELETE CASCADE,proof TEXT UNIQUE NOT NULL,saved INTEGER NOT NULL DEFAULT 0,joined INTEGER);
    CREATE TABLE IF NOT EXISTS account_devices(member TEXT NOT NULL REFERENCES members ON DELETE CASCADE,device TEXT NOT NULL,PRIMARY KEY(member,device));
    CREATE TABLE IF NOT EXISTS member_activity(member TEXT PRIMARY KEY REFERENCES members ON DELETE CASCADE,last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_presence(session TEXT PRIMARY KEY REFERENCES sessions ON DELETE CASCADE,seen INTEGER NOT NULL,online INTEGER NOT NULL CHECK(online IN (0,1)));
    CREATE TABLE IF NOT EXISTS admin_session_proofs(session TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,sealed BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_contacts(session TEXT PRIMARY KEY REFERENCES sessions ON DELETE CASCADE,challenge TEXT NOT NULL,consented INTEGER NOT NULL,encrypted BLOB);
    CREATE TABLE IF NOT EXISTS contacts(member TEXT PRIMARY KEY REFERENCES members ON DELETE CASCADE,encrypted BLOB NOT NULL,consented INTEGER NOT NULL,verified INTEGER NOT NULL,joined INTEGER);
    CREATE TABLE IF NOT EXISTS acceptances(member TEXT PRIMARY KEY REFERENCES members ON DELETE CASCADE,version TEXT NOT NULL,accepted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocks(owner TEXT NOT NULL REFERENCES members ON DELETE CASCADE,peer TEXT NOT NULL REFERENCES members ON DELETE CASCADE,PRIMARY KEY(owner,peer));
    CREATE INDEX IF NOT EXISTS blocked_peer ON blocks(peer,owner);
    CREATE TABLE IF NOT EXISTS reviews(message INTEGER PRIMARY KEY REFERENCES messages ON DELETE CASCADE,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_changes(room TEXT PRIMARY KEY REFERENCES rooms ON DELETE CASCADE,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS room_reads(room TEXT NOT NULL REFERENCES rooms ON DELETE CASCADE,member TEXT NOT NULL REFERENCES members ON DELETE CASCADE,through INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room,member));
    CREATE TABLE IF NOT EXISTS restrictions(identity TEXT PRIMARY KEY,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS penalty_events(content TEXT PRIMARY KEY,identity TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS penalties_by_identity ON penalty_events(identity);
    CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,reporter TEXT NOT NULL REFERENCES members ON DELETE CASCADE,target TEXT NOT NULL REFERENCES members ON DELETE CASCADE,message INTEGER REFERENCES messages ON DELETE CASCADE,reason TEXT NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open');
    CREATE INDEX IF NOT EXISTS reports_by_message ON reports(message,status);
    INSERT OR IGNORE INTO reviews SELECT id,'approved' FROM messages WHERE photo IS NOT NULL;
  `));
  transaction(db,()=>{
    // An approval belongs to one installation, not to the reusable invitation.
    // Keep pending legacy forms and their original expiry without claiming the
    // invitation for future users. Clearing the legacy pointer makes this safe
    // to run repeatedly, including after a partial deployment.
    for(const held of db.prepare('SELECT proof,pending_device,pending_until FROM used_invites WHERE pending_device IS NOT NULL').all()) {
      const existing=db.prepare('SELECT 1 FROM signup_gates WHERE device=?').get(held.pending_device);
      if(held.pending_until>Date.now() && !existing) {
        const grant=randomBytes(32).toString('hex');
        db.prepare('INSERT INTO signup_gates VALUES(?,?,?)').run(held.pending_device,grant,held.pending_until);
        db.prepare(`UPDATE sessions SET identity=?,expires=MIN(expires,?)
          WHERE identity=? AND kind IN ('gate_ok','details')`).run(grant,held.pending_until,held.proof);
      } else {
        db.prepare("DELETE FROM sessions WHERE identity=? AND kind IN ('gate_ok','details')").run(held.proof);
      }
      db.prepare('UPDATE used_invites SET pending_device=NULL,pending_until=NULL WHERE proof=?').run(held.proof);
    }
    if(!db.prepare('PRAGMA table_info(members)').all().some(c=>c.name==='deleted_at'))
      db.exec('ALTER TABLE members ADD COLUMN deleted_at INTEGER');
    if(!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='deleted_at'))
      db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
    const roomColumns=db.prepare('PRAGMA table_info(rooms)').all();
    if(!roomColumns.some(c=>c.name==='closed_at'))db.exec('ALTER TABLE rooms ADD COLUMN closed_at INTEGER');
    if(!roomColumns.some(c=>c.name==='closed_reason'))db.exec('ALTER TABLE rooms ADD COLUMN closed_reason TEXT');
    db.prepare('UPDATE messages SET expires=MIN(expires,sent+?) WHERE expires IS NOT NULL').run(12*hour);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deleted_messages'").get()) {
      // Merge legacy copies back into their original messages. A confirmed
      // moderation removal wins over every copy, and photo expiry never moves.
      db.exec(`INSERT OR REPLACE INTO reviews SELECT message,'removed' FROM reports
        WHERE message IS NOT NULL AND status IN ('accept','remove','suspend')`);
      db.prepare(`UPDATE messages SET
        deleted_at=COALESCE(deleted_at,(SELECT deleted_at FROM deleted_messages WHERE message=messages.id)),
        body=CASE WHEN EXISTS(SELECT 1 FROM reviews WHERE message=messages.id AND state='removed') THEN NULL
          ELSE COALESCE(body,(SELECT body FROM deleted_messages WHERE message=messages.id)) END,
        photo=CASE WHEN expires IS NULL OR expires<=? OR sent+?<=?
          OR EXISTS(SELECT 1 FROM reviews WHERE message=messages.id AND state='removed') THEN NULL
          ELSE COALESCE(photo,(SELECT photo FROM deleted_messages WHERE message=messages.id)) END
        WHERE id IN (SELECT message FROM deleted_messages)`).run(Date.now(),12*hour,Date.now());
      db.exec('DROP TABLE deleted_messages');
    }
    // Existing blocks must not resurrect a previous conversation when unblocked.
    for(const room of db.prepare(`SELECT r.id FROM rooms r WHERE r.closed_at IS NULL AND EXISTS(
      SELECT 1 FROM blocks b WHERE (b.owner=r.a AND b.peer=r.b) OR (b.owner=r.b AND b.peer=r.a))`).all())
      closeRoom(db,room.id,'blocked');
    // Unknown legacy activity begins at observation, never at a guessed date.
    db.prepare('INSERT OR IGNORE INTO member_activity SELECT id,? FROM members WHERE deleted_at IS NULL').run(Date.now());
    if(!db.prepare('PRAGMA table_info(reports)').all().some(c=>c.name==='content'))
      db.exec('ALTER TABLE reports ADD COLUMN content TEXT');
    if(!db.prepare('PRAGMA table_info(reports)').all().some(c=>c.name==='profile_snapshot'))
      db.exec('ALTER TABLE reports ADD COLUMN profile_snapshot TEXT');
    const reportColumns=db.prepare('PRAGMA table_info(reports)').all();
    if(!reportColumns.some(c=>c.name==='room'))db.exec('ALTER TABLE reports ADD COLUMN room TEXT REFERENCES rooms(id) ON DELETE CASCADE');
    if(!reportColumns.some(c=>c.name==='context_message'))db.exec('ALTER TABLE reports ADD COLUMN context_message INTEGER REFERENCES messages(id) ON DELETE SET NULL');
    if(!reportColumns.some(c=>c.name==='conversation_excerpt'))db.exec('ALTER TABLE reports ADD COLUMN conversation_excerpt TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS report_messages(
      report INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      message INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(report,message));
      CREATE INDEX IF NOT EXISTS report_messages_by_message ON report_messages(message,report);
      CREATE INDEX IF NOT EXISTS reports_by_room ON reports(room,status);
      CREATE TABLE IF NOT EXISTS penalty_contents(content TEXT PRIMARY KEY,
        event TEXT NOT NULL REFERENCES penalty_events(content) ON DELETE CASCADE);
      INSERT OR IGNORE INTO penalty_contents SELECT content,content FROM penalty_events;`);
    db.exec("UPDATE reports SET content='message:'||message WHERE content IS NULL AND message IS NOT NULL");
    // Only backfill an unreviewed profile when its recorded content hash still
    // matches. A changed current profile is not evidence of an earlier report.
    for(const row of db.prepare(`SELECT r.id,r.target,r.content,m.nick,m.memo,m.area FROM reports r
      JOIN members m ON m.id=r.target WHERE r.message IS NULL AND r.room IS NULL AND r.status='open' AND r.profile_snapshot IS NULL`).all()) {
      const content='profile:'+row.target+':'+
        createHash('sha256').update(JSON.stringify({nick:row.nick,memo:row.memo})).digest('hex');
      if(content===row.content)db.prepare('UPDATE reports SET profile_snapshot=? WHERE id=?').run(JSON.stringify({nick:row.nick,area:row.area,memo:row.memo}),row.id);
    }
    migrateMemberAreas(db);
    // Only legacy, unreported, unexpired pending photos become public. Decisions
    // and open reports survive this migration unchanged.
    db.prepare(`UPDATE reviews SET state='approved' WHERE state='pending'
      AND message IN (SELECT id FROM messages WHERE photo IS NOT NULL AND expires>?)
      AND NOT ${openMessageReportSQL('reviews.message')}`).run(Date.now());
  });
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Call inside the surrounding leave/block transaction.
export function closeRoom(db,id,reason,now=Date.now()) {
  const changed=db.prepare('UPDATE rooms SET closed_at=?,closed_reason=? WHERE id=? AND closed_at IS NULL').run(now,reason,id);
  if(!changed.changes)return false;
  db.prepare('UPDATE messages SET deleted_at=COALESCE(deleted_at,?) WHERE room=?').run(now,id);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_jobs'").get())
    db.prepare('DELETE FROM push_jobs WHERE message IN (SELECT id FROM messages WHERE room=?)').run(id);
  db.prepare('INSERT INTO room_changes VALUES(?,1) ON CONFLICT(room) DO UPDATE SET version=version+1').run(id);
  return true;
}
export function clean(db, now=Date.now()) {
  transaction(db, () => {
    db.prepare('UPDATE used_invites SET pending_device=NULL,pending_until=NULL WHERE pending_until<=?').run(now);
    db.prepare("DELETE FROM sessions WHERE kind IN ('gate_ok','details') AND identity IN (SELECT proof FROM signup_gates WHERE expires<=?)").run(now);
    db.prepare('DELETE FROM signup_gates WHERE expires<=?').run(now);
    db.prepare('UPDATE messages SET photo=NULL WHERE expires<=? AND photo IS NOT NULL').run(now);
    for (const [table,field] of [['sessions','expires'],['cooldowns','until'],['attempts','until'],['restrictions','until'],['departures','expires']])
      db.prepare('DELETE FROM '+table+' WHERE '+field+'<=?').run(now);
  });
}
