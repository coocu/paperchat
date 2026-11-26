import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const hour = 3600_000;
export const tables = ['used_invites','account_devices','account_keys','push_jobs','push_devices','admin_session_proofs','departures','pending_contacts','contacts','reports','penalty_events','reviews','room_reads','room_changes','blocks','acceptances','restrictions','messages','rooms','sessions','members','cooldowns','settings','attempts'];
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
    CREATE TABLE IF NOT EXISTS account_keys(member TEXT PRIMARY KEY REFERENCES members ON DELETE CASCADE,proof TEXT UNIQUE NOT NULL,saved INTEGER NOT NULL DEFAULT 0,joined INTEGER);
    CREATE TABLE IF NOT EXISTS account_devices(member TEXT NOT NULL REFERENCES members ON DELETE CASCADE,device TEXT NOT NULL,PRIMARY KEY(member,device));
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
    if(!db.prepare('PRAGMA table_info(reports)').all().some(c=>c.name==='content'))
      db.exec('ALTER TABLE reports ADD COLUMN content TEXT');
    db.exec("UPDATE reports SET content='message:'||message WHERE content IS NULL AND message IS NOT NULL");
    for(const row of db.prepare('SELECT DISTINCT target FROM reports WHERE content IS NULL').all()) {
      const profile=db.prepare('SELECT nick,memo FROM members WHERE id=?').get(row.target);
      const content='profile:'+row.target+':'+createHash('sha256').update(JSON.stringify(profile)).digest('hex');
      db.prepare('UPDATE reports SET content=? WHERE content IS NULL AND target=?').run(content,row.target);
    }
    // Only legacy, unreported, unexpired pending photos become public. Decisions
    // and open reports survive this migration unchanged.
    db.prepare(`UPDATE reviews SET state='approved' WHERE state='pending'
      AND message IN (SELECT id FROM messages WHERE photo IS NOT NULL AND expires>?)
      AND NOT EXISTS(SELECT 1 FROM reports WHERE reports.message=reviews.message AND status='open')`).run(Date.now());
  });
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function clean(db, now=Date.now()) {
  transaction(db, () => {
    db.prepare('UPDATE used_invites SET pending_device=NULL,pending_until=NULL WHERE pending_until<=?').run(now);
    db.prepare('UPDATE messages SET photo=NULL WHERE expires<=? AND photo IS NOT NULL').run(now);
    for (const [table,field] of [['sessions','expires'],['cooldowns','until'],['attempts','until'],['restrictions','until'],['departures','expires']])
      db.prepare('DELETE FROM '+table+' WHERE '+field+'<=?').run(now);
  });
}
