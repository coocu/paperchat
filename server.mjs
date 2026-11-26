import http from 'node:http';
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openStore, hour, transaction, clean, tables } from './store.mjs';
import { providers, reject, profileDetails, RequestError } from './providers.mjs';

import { textVault } from './vault.mjs';
import { contactVault } from './contacts.mjs';
import { pushProvider } from './push-provider.mjs';
import { pushQueue } from './push-queue.mjs';
import { moderation, checkText } from './moderation.mjs';
import { policyVersion } from './public/rules.js';

const regions=JSON.parse(readFileSync(new URL('./regions.json',import.meta.url)));
const areas=new Set(Object.entries(regions).flatMap(([p,ds])=>ds.map(d=>p+' '+d)));
const profileCols='id,nick,year,gender,area,memo';
const assets=new Map(Object.entries({'/app':'index.html','/admin':'index.html','/app.js':'app.js','/theme.css':'theme.css','/icon.svg':'icon.svg','/headings.woff':'headings.woff','/rules.js':'rules.js'}));
const type={html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',woff:'font/woff'};
const token=()=>randomBytes(32).toString('hex');
const digest=s=>createHash('sha256').update(s).digest();
const limit=1_500_000;

function string(s,min,max,label) {
  if(typeof s!=='string' || s.trim().length<min || s.trim().length>max) reject(400,label+'을(를) 확인해 주세요.');
  return s.trim();
}
function same(a,b) { return timingSafeEqual(digest(a),digest(b)); }
function finish(res,status,body,kind='application/json; charset=utf-8') {
  res.writeHead(status,{'Content-Type':kind});
  res.end(kind.startsWith('application/json')?JSON.stringify(body):body);
}
async function payload(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) reject(415,'요청 형식이 올바르지 않아요.');
  let size=0; const chunks=[];
  for await(const chunk of req) {
    size+=chunk.length; if(size>2_010_000) reject(413,'사진은 1.5MB 이하로 보내 주세요.');
    chunks.push(chunk);
  }
  try { const obj=JSON.parse(Buffer.concat(chunks)); if(obj && typeof obj==='object' && !Array.isArray(obj)) return obj; }
  catch {}
  reject(400,'입력값을 확인해 주세요.');
}
export function makeServer(config, upstream=providers) {
  const {secret,origin}=config;
  if(typeof secret!=='string' || secret.length<32)
    throw Error('SECRET을 32자 이상으로 설정하세요.');
  const base=new URL(origin).origin, secure=base.startsWith('https://');
  if(!secure && !['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname)) throw Error('HTTPS URL을 설정하세요.');
  const db=openStore(config.dir), h=(scope,v)=>createHmac('sha256',secret).update(scope+'|'+v).digest('hex');
  const safety=moderation(db);
  const delivery=config.pushProvider || pushProvider();
  const pushes=pushQueue(db,delivery,safety);
  // Both directory listings and room listings join the other member as p.
  const visiblePeer=`NOT EXISTS(SELECT 1 FROM restrictions x WHERE x.identity=p.identity AND x.until>?)
    AND NOT EXISTS(SELECT 1 FROM blocks x WHERE (x.owner=? AND x.peer=p.id) OR (x.owner=p.id AND x.peer=?))`;
  const vault=contactVault(secret);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  run("INSERT OR IGNORE INTO service_meta VALUES('reset',?)",token());
  const resetVersion=()=>get("SELECT value FROM service_meta WHERE key='reset'").value;
  const adminVault=textVault(secret,'paperchat/admin-session/v1');
  // Sessions issued by the former local-password login have no registry key.
  run("DELETE FROM sessions WHERE kind='admin' AND NOT EXISTS(SELECT 1 FROM admin_session_proofs WHERE session=sessions.id)");
  const checksInFlight=new Map();
  function registryApproved(answer) {
    return answer?.status==='approved' && typeof answer.token==='string' && Boolean(answer.token.trim());
  }
  function adminCode(value) {
    const code=typeof value==='string' ? value.trim() : '';
    if(code.length>256 || !code.includes('codenote') || !code.includes('kyh'))
      reject(403,'승인된 관리자 보안키를 확인해 주세요.');
    return code;
  }
  async function stillApproved(s) {
    if(!s) return false;
    // Overlapping UI requests share only the current lookup. No positive cache.
    let pending=checksInFlight.get(s.id);
    if(!pending) {
      const code=adminVault.open(s.proof,s.id);
      pending=upstream.check(code).then(registryApproved).finally(()=>checksInFlight.delete(s.id));
      checksInFlight.set(s.id,pending);
    }
    if(!await pending){
      run('DELETE FROM sessions WHERE id=?',s.id);
      return false;
    }
    return Boolean(get("SELECT 1 FROM sessions WHERE id=? AND kind='admin' AND expires>?",s.id,Date.now()));
  }
  function recoveryCode(member) {
    return h('recovery-code-v1',member).slice(0,32).toUpperCase().match(/.{4}/g).join('-');
  }
  function proof(code) { return h('recovery-index',code.replace(/[-\s]/g,'').toUpperCase()); }
  const attachKey=db.prepare('INSERT INTO account_keys(member,proof,joined) VALUES(?,?,?)');
  transaction(db,()=>{
    for(const m of all('SELECT id FROM members WHERE id NOT IN (SELECT member FROM account_keys)'))
      attachKey.run(m.id,proof(recoveryCode(m.id)),null);
    if(!get("SELECT 1 FROM service_meta WHERE key='signup-birth-date'")) {
      run("UPDATE sessions SET kind='gate_ok',year=NULL,gender=NULL WHERE kind='details'");
      run("INSERT INTO service_meta VALUES('signup-birth-date','1')");
    }
    // Old in-progress carrier claims cannot complete registration in the new flow.
    run("DELETE FROM sessions WHERE kind='verified' OR (kind='gate_ok' AND identity IS NULL)");
  });
  function device(req,res) {
    if(req.installId)return req.installId;
    let raw=(req.headers.cookie || '').split(';').map(c=>c.trim()).find(c=>c.startsWith('pc_install='))?.slice(11);
    if(!/^[a-f0-9]{64}$/.test(raw || '')) {
      raw=token();cookie(res,'pc_install',raw,365*24*hour);
    }
    req.installId=h('install',raw);return req.installId;
  }
  function checkSignup(identity) {
    cooldown(identity);
    if(safety.restricted(identity))reject(403,'이용 제한 기간에는 가입할 수 없어요.');
  }
  function throttle(key,max,window) {
    const k=h('rate',key), now=Date.now();
    run('INSERT INTO attempts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN until<=? THEN 1 ELSE hits+1 END, until=CASE WHEN until<=? THEN excluded.until ELSE until END',k,1,now+window,now,now);
    if(get('SELECT hits FROM attempts WHERE key=?',k).hits>max) reject(429,'시도가 많아요. 잠시 후 다시 시도해 주세요.');
  }
  function cookie(res,name,value,ttl) {
    const previous=res.getHeader('Set-Cookie') || [];
    res.setHeader('Set-Cookie',[...previous,name+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+Math.floor(ttl/1000)+(secure?'; Secure':'')]);
  }
  function issue(res,kind,ttl,member=null,adminCredential=null) {
    const raw=token(),id=h('session',raw);
    run('INSERT INTO sessions(id,kind,expires,member) VALUES(?,?,?,?)',id,kind,Date.now()+ttl,member);
    if(adminCredential)run('INSERT INTO admin_session_proofs(session,sealed) VALUES(?,?)',id,adminVault.seal(adminCredential,id));
    cookie(res,kind==='admin'?'pc_admin':'pc_user',raw,ttl);
    return id;
  }
  function cookieValue(req,name) {
    return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
  }
  function sessions(req,admin=false) {
    const v=cookieValue(req,admin?'pc_admin':'pc_user');
    if(!v || !/^[a-f0-9]{64}$/.test(v)) return;
    const id=h('session',v), now=Date.now();
    if(admin)return get(`SELECT s.*,p.sealed AS proof FROM sessions s JOIN admin_session_proofs p ON p.session=s.id
      WHERE s.id=? AND s.kind='admin' AND s.expires>?`,id,now);
    return get("SELECT * FROM sessions WHERE id=? AND kind!='admin' AND expires>?",id,now);
  }
  function need(req,kind,limited=false) {
    const s=sessions(req,kind==='admin');
    if(!s || s.kind!==kind) reject(401,'이 화면을 이용하려면 다시 인증해 주세요.');
    if(kind==='member' && !limited && safety.memberStage(s.member)!=='member')
      reject(403,'이용규칙 또는 계정 이용 상태를 확인해 주세요.');
    return s;
  }
  function cooldown(id) {
    const c=get('SELECT until FROM cooldowns WHERE identity=? AND until>?',id,Date.now());
    if(c) reject(403,new Date(c.until).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})+' 이후에 다시 가입할 수 있어요.');
  }
  function roomFor(req,id,admin=false) {
    if(admin) need(req,'admin');
    const room=get('SELECT * FROM rooms WHERE id=?',id);
    const member=admin?null:need(req,'member').member;
    if(!room || (!admin && room.a!==member && room.b!==member)) reject(404,'대화방을 찾을 수 없어요.');
    if(!admin)safety.pairAllowed(member,room.a===member?room.b:room.a);
    return room;
  }
  function processMessages(room,u,admin) {
    const before=u.searchParams.get('before');
    if(before && !/^\d+$/.test(before)) reject(400,'조회 범위를 확인해 주세요.');
    const data=all(`SELECT m.id,m.author,p.nick,m.sent,m.body,m.expires,v.state,
      (m.photo IS NOT NULL AND m.expires>?) AS live,
      EXISTS(SELECT 1 FROM reports f WHERE f.message=m.id AND f.status='open') AS reported
      FROM messages m JOIN members p ON m.author=p.id LEFT JOIN reviews v ON v.message=m.id
      WHERE m.room=? AND m.id<? ORDER BY m.id DESC LIMIT 60`,Date.now(),room,before?Number(before):Number.MAX_SAFE_INTEGER);
    return data.reverse().map(({state,live,reported,...m})=>{
      let visibility='visible';
      if(state==='removed')visibility='removed';
      else if(m.expires && !live)visibility='expired';
      else if(reported && !admin)visibility='reported';
      else if(m.expires && state!=='approved' && !admin)visibility='pending';
      return {...m,visibility,body:visibility==='visible'?m.body:null,viewable:Number(Boolean(live && visibility==='visible'))};
    });
  }
  function configURL(){return get("SELECT value FROM settings WHERE name='form'")?.value||'';}
  async function handle(req,res) {
    const u=new URL(req.url,base), p=u.pathname, post=req.method==='POST';
    res.setHeader('Cache-Control','no-store, private');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    const ip=(process.env.RENDER==='true'?String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim():'')||req.socket.remoteAddress;
    if(!post && req.method!=='GET') reject(405,'허용되지 않은 요청이에요.');
    const ok=(data={})=>finish(res,200,data);
    // Select the UI only. Each data API checks its own session and permissions.
    const ua=req.headers['user-agent'] || '';
    const native=/\bPaperChat(?:Android|IOS)\/\d+\b/.test(ua);
    // Support previously installed iOS shells until they adopt the app marker.
    const oldWebView=/AppleWebKit\//.test(ua) && /Mobile\//.test(ua) && !/Safari\//.test(ua);
    const mobile=native || oldWebView;
    if(!post && (p==='/' || p==='/admin/' || p==='/app/' || (p==='/app' && !mobile) || p==='/identity-return')) {
      const destination=mobile && p!=='/admin/' ? '/app'+u.search : '/admin';
      res.writeHead(302,{Location:destination,Vary:'User-Agent'});return res.end();
    }
    if(!post && p==='/api/push/availability') {
      const available=platform=>Boolean(delivery.enabled(platform));
      return ok({android:Boolean(delivery.androidClient) && available('android'),
        'ios-dev':available('ios-dev'),'ios-prod':available('ios-prod')});
    }
    if(!post && assets.has(p)) {
      const file=assets.get(p);
      return finish(res,200,readFileSync(new URL('./public/'+file,import.meta.url)),type[file.split('.').at(-1)]+'; charset=utf-8');
    }
    if(!post && p==='/api/push/android-config') {
      return ok({config:delivery.androidClient || null});
    }
    if(!post && p==='/health') return ok({ok:true});
    if(!post && p==='/apply') {
      const link=configURL();
      if(!link) {
        if(!mobile)return finish(res,200,'아직 등록된 인증키 발급 주소가 없습니다. 앱으로 돌아가 주세요.','text/plain; charset=utf-8');
        res.writeHead(303,{Location:'/app?form=unavailable'});return res.end();
      }
      res.writeHead(303,{Location:link});return res.end();
    }
    const revision=resetVersion();
    res.setHeader('X-Service-Version',revision);
    if(!post && p==='/api/status'){
      const s=sessions(req);
      const adminSignedIn=u.searchParams.has('member') ? false : await stillApproved(sessions(req,true));
      if(revision!==resetVersion())reject(409,'서버가 초기화됐어요.');
      if(!s && /(?:^|;\s*)pc_user=/.test(req.headers.cookie||''))cookie(res,'pc_user','',0);
      return ok({version:revision,adminSignedIn,stage:s?.kind==='member'?safety.memberStage(s.member):(s?.kind||'gate')});
    }
    let b={};
    if(post) {
      if(req.headers.origin!==base) reject(403,'요청 출처를 확인할 수 없어요.');
      b=await payload(req);
      if(revision!==resetVersion()) reject(409,'서버가 초기화됐어요.');
    }
    if(p.startsWith('/api/admin/') && p!=='/api/admin/login' && p!=='/api/admin/logout') {
      const s=need(req,'admin');
      if(post && p==='/api/admin/reset') {
        throttle('admin-reset:'+ip,12,hour/4);
        if(b.confirm!=='전체 삭제' || !same(adminCode(b.key),adminVault.open(s.proof,s.id)))
          reject(403,'로그인한 관리자 보안키와 전체 삭제 문구를 확인해 주세요.');
      }
      if(!await stillApproved(s)) reject(401,'관리자 보안키의 승인을 다시 확인해 주세요.');
      if(revision!==resetVersion())reject(409,'서버가 초기화됐어요.');
    }
    if(post && p==='/api/push/device') {
      const s=need(req,'member');
      return ok(pushes.bind(s.id,b.platform,b.token));
    }
    if(!post && p==='/api/state') {
      let s=sessions(req);
      const install=device(req,res);
      if(!s) {
        const held=get('SELECT proof,pending_until FROM used_invites WHERE pending_device=? AND pending_until>?',install,Date.now());
        if(held){
          const sid=issue(res,'gate_ok',held.pending_until-Date.now());
          run('UPDATE sessions SET identity=? WHERE id=?',held.proof,sid);
          s={kind:'gate_ok'};
        }
      }
      const stage=s?.kind==='member'?safety.memberStage(s.member):(s?.kind||'gate');
      let needsRecoveryCopy=false;
      if(s?.kind==='member') {
        run('INSERT OR IGNORE INTO account_devices VALUES(?,?)',s.member,device(req,res));
        needsRecoveryCopy=!get('SELECT saved FROM account_keys WHERE member=?',s.member)?.saved;
      }
      return ok({stage,nick:s?.nick||'',year:s?.year,gender:s?.gender,needsRecoveryCopy,
        profile:stage==='member'?get('SELECT '+profileCols+' FROM members WHERE id=?',s.member):null});
    }
    if(!post && p==='/api/regions') return ok(regions);
    if(post && p==='/api/key') {
      throttle('key:'+ip,20,hour/4);
      const code=string(b.code,1,256,'인증키');
      const invitation=h('invite',code.normalize('NFKC').toLowerCase());
      const install=device(req,res);
      const unused=()=>{
        if(get('SELECT 1 FROM used_invites WHERE proof=?',invitation))reject(409,'이미 사용한 가입 인증키예요.');
        if(get('SELECT 1 FROM used_invites WHERE pending_device=? AND pending_until>?',install,Date.now()))
          reject(409,'이 기기에서 진행 중인 가입을 먼저 완료해 주세요.');
      };
      checkSignup(install);unused();
      const v=await upstream.check(code);
      if(v?.status==='pending') reject(403,'승인 대기 중이에요.');
      if(!registryApproved(v)) reject(403,'승인된 인증키를 확인해 주세요.');
      if(revision!==resetVersion()) reject(409,'서버가 초기화됐어요.');
      transaction(db,()=>{
        checkSignup(install);unused();
        const prev=sessions(req);
        if(prev?.kind==='member')reject(409,'이미 로그인한 계정이에요.');
        if(prev)run('DELETE FROM sessions WHERE id=?',prev.id);
        run('UPDATE used_invites SET pending_device=NULL,pending_until=NULL WHERE pending_device=?',install);
        run('INSERT INTO used_invites VALUES(?,?,?)',invitation,install,Date.now()+24*hour);
        const sid=issue(res,'gate_ok',24*hour);
        run('UPDATE sessions SET identity=? WHERE id=?',invitation,sid);
      });
      return ok();
    }
    if(post && p==='/api/profile-details') {
      const s=sessions(req);
      if(!s || !['gate_ok','details'].includes(s.kind))reject(401,'먼저 일반 인증키를 입력해 주세요.');
      checkSignup(device(req,res));
      const nick=string(b.nick,1,24,'닉네임');
      checkText(nick);
      const {year,gender}=profileDetails(b);
      run("UPDATE sessions SET kind='details',year=?,gender=?,nick=? WHERE id=?",year,gender,nick,s.id);
      return ok({stage:'details'});
    }
    if(post && p==='/api/account/login') {
      const s=sessions(req);
      throttle('recovery:'+ip,20,hour/4);
      const code=string(b.code,1,64,'개인 복구코드');
      const credential=proof(code);
      const account=get('SELECT member FROM account_keys WHERE proof=?',credential);
      if(!account) {
        checkSignup(credential);
        reject(403,'개인 복구코드를 확인해 주세요.');
      }
      transaction(db,()=>{
        run('INSERT OR IGNORE INTO account_devices VALUES(?,?)',account.member,device(req,res));
        if(s)run('DELETE FROM sessions WHERE id=?',s.id);
        issue(res,'member',24*30*hour,account.member);
      });
      return ok({stage:safety.memberStage(account.member)});
    }
    if(p==='/api/account/recovery') {
      const s=need(req,'member',true);
      if(!post)return ok({code:recoveryCode(s.member)});
      if(b.saved!==true)reject(400,'코드를 따로 보관한 뒤 확인해 주세요.');
      run('UPDATE account_keys SET saved=1 WHERE member=?',s.member);
      return ok();
    }
    if(post && p==='/api/register') {
      const s=need(req,'details');
      const install=device(req,res);
      checkSignup(install);
      if(!areas.has(b.area)) reject(400,'지역을 선택해 주세요.');
      const memo=string(b.memo,1,800,'성향 메모');
      checkText(memo);checkText(s.nick);
      if(b.policy!==policyVersion)reject(400,'이용규칙을 확인하고 동의해 주세요.');
      transaction(db,()=>{
        const consumed=run('UPDATE used_invites SET pending_device=NULL,pending_until=NULL WHERE proof=? AND pending_device=? AND pending_until>?',s.identity,install,Date.now());
        if(consumed.changes!==1)reject(409,'가입 요청이 만료되었거나 이미 처리됐어요.');
        const id=randomUUID(),credential=proof(recoveryCode(id));
        run('INSERT INTO members VALUES(?,?,?,?,?,?,?)',id,credential,s.nick,s.year,s.gender,b.area,memo);
        attachKey.run(id,credential,Date.now());
        run('INSERT INTO account_devices VALUES(?,?)',id,install);
        safety.accept(id,b.policy);
        // Keep this already-issued secret usable if the registration response is lost.
        const ttl=24*30*hour;
        run("UPDATE sessions SET kind='member',member=?,identity=NULL,nick=NULL,gender=NULL,year=NULL,expires=? WHERE id=?",id,Date.now()+ttl,s.id);
        cookie(res,'pc_user',cookieValue(req,'pc_user'),ttl);
      });
      return ok();
    }
    if(post && p==='/api/logout') {
      const s=sessions(req);if(s) run('DELETE FROM sessions WHERE id=?',s.id);
      cookie(res,'pc_user','',0);return ok();
    }
    if(post && p==='/api/policy') {
      const s=need(req,'member',true);safety.accept(s.member,b.version);return ok();
    }
    if(p==='/api/blocks') {
      const s=need(req,'member');
      if(!post)return ok(all('SELECT p.id,p.nick FROM blocks x JOIN members p ON x.peer=p.id WHERE x.owner=? ORDER BY p.nick',s.member));
      safety.setBlock(s.member,b.peer,b.remove===true);return ok();
    }
    if(post && p==='/api/report') {
      const s=need(req,'member');throttle('report:'+s.member,30,hour);
      safety.report(s.member,b);return ok();
    }
    if(post && p==='/api/withdraw') {
      const s=need(req,'member',true);
      if(b.confirm!==true) reject(400,'회원탈퇴를 확인해 주세요.');
      transaction(db,()=>{
        const m=get('SELECT identity,nick FROM members WHERE id=?',s.member);
        const withdrawn=Date.now(),expires=withdrawn+24*hour;
        run('INSERT INTO departures VALUES(?,?,?,?)',s.member,m.nick,withdrawn,expires);
        const devices=all('SELECT device FROM account_devices WHERE member=?',s.member).map(row=>row.device);
        const keys=new Set([m.identity,proof(recoveryCode(s.member)),device(req,res),...devices]);
        const restrictedUntil=safety.restricted(m.identity);
        for(const key of keys) {
          run('INSERT INTO cooldowns VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET until=MAX(until,excluded.until)',key,expires);
          if(restrictedUntil)run('INSERT INTO restrictions VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET until=MAX(until,excluded.until)',key,restrictedUntil);
        }
        run('DELETE FROM sessions WHERE identity=?',m.identity);
        run('DELETE FROM members WHERE id=?',s.member);
      });
      cookie(res,'pc_user','',0);return ok();
    }
    if(!post && p==='/api/people') {
      const s=need(req,'member');
      const area=u.searchParams.get('area');
      if(!areas.has(area)) reject(400,'지역을 선택해 주세요.');
      return ok(all('SELECT '+profileCols+' FROM members p WHERE area=? AND id<>? AND '+visiblePeer+' ORDER BY nick,id',area,s.member,Date.now(),s.member,s.member));
    }
    if(!post && p==='/api/rooms') {
      const s=need(req,'member');
      return ok(all(`SELECT r.id,p.id AS peer,p.nick,p.area,MAX(m.sent) AS recent FROM rooms r
        JOIN members p ON p.id=CASE WHEN r.a=? THEN r.b ELSE r.a END
        LEFT JOIN messages m ON m.room=r.id WHERE (r.a=? OR r.b=?) AND ${visiblePeer} GROUP BY r.id ORDER BY recent DESC`,s.member,s.member,s.member,Date.now(),s.member,s.member));
    }
    if(post && p==='/api/room') {
      const s=need(req,'member');
      if(!get('SELECT id FROM members WHERE id=?',String(b.peer)) || b.peer===s.member) reject(404,'상대 프로필을 찾을 수 없어요.');
      safety.pairAllowed(s.member,b.peer);
      const [a,other]=[s.member,b.peer].sort();
      run('INSERT OR IGNORE INTO rooms VALUES(?,?,?)',randomUUID(),a,other);
      return ok(get('SELECT id FROM rooms WHERE a=? AND b=?',a,other));
    }
    const dialog=p.match(/^\/api\/(admin\/)?rooms\/([a-f0-9-]+)\/messages$/);
    if(dialog) {
      const admin=!!dialog[1], room=roomFor(req,dialog[2],admin);
      if(!post) {
        res.setHeader('X-Room-Version',String(get('SELECT version FROM room_changes WHERE room=?',room.id)?.version||0));
        return ok(processMessages(room.id,u,admin));
      }
      if(admin) reject(405,'열람 전용 화면이에요.');
      const s=need(req,'member'), now=Date.now();
      throttle('send:'+s.member,100,60_000);
      let body=null,photo=null;
      if(b.photo) {
        if(typeof b.photo!=='string') reject(400,'사진을 확인해 주세요.');
        photo=Buffer.from(b.photo,'base64');
        if(photo.length<4 || photo.length>limit || photo.readUInt16BE(0)!==0xffd8 || photo.readUInt16BE(photo.length-2)!==0xffd9)
          reject(400,'1.5MB 이하 JPEG 사진을 보내 주세요.');
      } else {body=string(b.body,1,2000,'메시지');checkText(body);}
      transaction(db,()=>{
        const entry=run('INSERT INTO messages(room,author,sent,body,photo,expires) VALUES(?,?,?,?,?,?)',room.id,s.member,now,body,photo,photo?now+12*hour:null);
        if(photo)run("INSERT INTO reviews VALUES(?,'pending')",entry.lastInsertRowid);
        else pushes.enqueue(entry.lastInsertRowid);
      });
      return ok();
    }
    const media=p.match(/^\/api\/(admin\/)?photos\/(\d+)$/);
    if(media && !post) {
      const meta=get('SELECT room FROM messages WHERE id=?',media[2]);
      if(!meta) reject(404,'사진을 찾을 수 없어요.');
      roomFor(req,meta.room,!!media[1]);
      if(!media[1] && !get(`SELECT 1 FROM reviews v WHERE v.message=? AND v.state='approved'
        AND NOT EXISTS(SELECT 1 FROM reports f WHERE f.message=v.message AND f.status='open')`,media[2]))
        reject(403,'열람할 수 없는 사진이에요.');
      const m=get('SELECT photo FROM messages WHERE id=? AND expires>? AND photo IS NOT NULL',media[2],Date.now());
      if(!m) reject(410,'보관 기간이 지난 사진이에요.');
      return finish(res,200,Buffer.from(m.photo),'image/jpeg');
    }
    if(p==='/api/admin/login' && post) {
      throttle('admin:'+ip,12,hour/4);
      const code=adminCode(b.key);
      if(!registryApproved(await upstream.check(code))) reject(403,'승인된 관리자 보안키를 확인해 주세요.');
      if(revision!==resetVersion()) reject(409,'서버가 초기화됐어요.');
      transaction(db,()=>{
        const prev=sessions(req,true);if(prev)run('DELETE FROM sessions WHERE id=?',prev.id);
        issue(res,'admin',4*hour,null,code);
      });
      return ok();
    }
    if(p.startsWith('/api/admin/')) {
      const s=need(req,'admin');
      if(p==='/api/admin/members' && !post) {
        const offset=Number(u.searchParams.get('offset')||0);
        if(!Number.isSafeInteger(offset)||offset<0)reject(400,'목록 범위를 확인해 주세요.');
        const now=Date.now();
        const counts={active:get('SELECT COUNT(*) AS n FROM members').n,
          withdrawn:get('SELECT COUNT(*) AS n FROM departures WHERE expires>?',now).n};
        const members=all(`SELECT * FROM (
          SELECT p.id,p.nick,p.area,COALESCE(k.joined,c.joined) AS joined,'active' AS status,NULL AS withdrawn,NULL AS expires
          FROM members p LEFT JOIN account_keys k ON k.member=p.id LEFT JOIN contacts c ON p.id=c.member
          UNION ALL SELECT id,nick,NULL,NULL,'withdrawn',withdrawn,expires FROM departures WHERE expires>?
        ) ORDER BY status,nick,id LIMIT 51 OFFSET ?`,now,offset);
        return ok({items:members.slice(0,50),more:members.length>50,counts});
      }
      const memberPath=p.match(/^\/api\/admin\/members\/([a-f0-9-]+)$/);
      if(memberPath && !post){
        const m=get(`SELECT p.id,p.nick,p.year,p.gender,p.area,p.memo,p.identity,c.encrypted,c.verified,COALESCE(k.joined,c.joined) AS joined
          FROM members p LEFT JOIN account_keys k ON k.member=p.id LEFT JOIN contacts c ON c.member=p.id WHERE p.id=?`,memberPath[1]);
        if(!m){
          const departed=get("SELECT nick,withdrawn,expires,'withdrawn' AS status FROM departures WHERE id=? AND expires>?",memberPath[1],Date.now());
          if(departed)return ok(departed);
          reject(404,'가입자 정보가 없어요.');
        }
        const {identity,encrypted,...profile}=m;
        return ok({...profile,contact:vault.read(encrypted,identity),restrictedUntil:safety.restricted(identity)});
      }
      if(p==='/api/admin/review' && !post)return ok(safety.queue());
      if(p==='/api/admin/review' && post) {
        if(!Number.isSafeInteger(b.id))reject(400,'검토 대상을 확인해 주세요.');
        if(b.kind==='photo')safety.photoDecision(b.id,b.action,pushes.enqueue);
        else if(b.kind==='report')safety.reportDecision(b.id,b.action);
        else reject(400,'검토 대상을 확인해 주세요.');
        return ok();
      }
      if(p==='/api/admin/settings' && !post) return ok({url:configURL()});
      if(p==='/api/admin/settings' && post) {
        let url;try {url=new URL(string(b.url,1,2048,'URL'));}catch{reject(400,'올바른 HTTPS 주소를 입력해 주세요.');}
        if(url.protocol!=='https:' || url.username || url.password) reject(400,'올바른 HTTPS 주소를 입력해 주세요.');
        run("INSERT OR REPLACE INTO settings VALUES('form',?)",url.href);return ok();
      }
      if(p==='/api/admin/rooms' && !post) {
        const area=u.searchParams.get('area');
        if(!areas.has(area)) reject(400,'지역을 선택해 주세요.');
        return ok(all(`SELECT r.id,x.nick AS first,y.nick AS second,MAX(m.sent) AS recent
          FROM rooms r JOIN members x ON r.a=x.id JOIN members y ON r.b=y.id
          LEFT JOIN messages m ON m.room=r.id WHERE x.area=? OR y.area=? GROUP BY r.id ORDER BY recent DESC`,area,area));
      }
      if(p==='/api/admin/reset' && post) {
        transaction(db,()=>{for(const table of tables) db.exec('DELETE FROM '+table);db.exec("DELETE FROM sqlite_sequence WHERE name='messages'");run("UPDATE service_meta SET value=? WHERE key='reset'",token());});
        cookie(res,'pc_admin','',0);return ok();
      }
      if(p==='/api/admin/logout' && post) {run('DELETE FROM sessions WHERE id=?',s.id);cookie(res,'pc_admin','',0);return ok();}
    }
    reject(404,'페이지를 찾을 수 없어요.');
  }
  const server=http.createServer((req,res)=>handle(req,res).catch(e=>{
    if(!(e instanceof RequestError)) console.error('Internal failure:',e.code || e.name);
    if(!res.headersSent) finish(res,e.status||500,{error:e.status?e.message:'처리하지 못했어요. 잠시 후 다시 시도해 주세요.'});
    else res.end();
  }));
  clean(db);
  const timer=setInterval(()=>clean(db),30000);timer.unref();
  const pushTimer=setInterval(()=>pushes.flush().catch(()=>console.error('알림 대기열 처리 오류')),1000);
  pushTimer.unref();
  server.on('close',()=>{clearInterval(timer);clearInterval(pushTimer);pushes.close();db.close();});
  return server;
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const env=process.env,port=Number(env.PORT||3000);
  const origin=env.PUBLIC_BASE_URL||env.RENDER_EXTERNAL_URL||('http://localhost:'+port);
  const server=makeServer({origin,dir:env.DATA_DIR||fileURLToPath(new URL('./data',import.meta.url)),
    secret:env.SECRET});
  server.listen(port,'0.0.0.0',()=>console.log('채팅 서버 시작 ('+port+')'));
}
