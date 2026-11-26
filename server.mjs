import http from 'node:http';
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openStore, hour, transaction, clean, tables } from './store.mjs';
import { providers, reject, adultInfo, RequestError } from './providers.mjs';

import { textVault } from './vault.mjs';
import { contactVault } from './contacts.mjs';
import { pushProvider } from './push-provider.mjs';
import { pushQueue } from './push-queue.mjs';
import { moderation, checkText } from './moderation.mjs';
import { policyVersion } from './public/rules.js';

const regions=JSON.parse(readFileSync(new URL('./regions.json',import.meta.url)));
const areas=new Set(Object.entries(regions).flatMap(([p,ds])=>ds.map(d=>p+' '+d)));
const profileCols='id,nick,year,gender,area,memo';
const assets=new Map(Object.entries({'/':'index.html','/admin':'index.html','/identity-return':'index.html','/app.js':'app.js','/theme.css':'theme.css','/icon.svg':'icon.svg','/headings.woff':'headings.woff','/rules.js':'rules.js'}));
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
  function saveContact(id,claim,isNew) {
    run(`INSERT INTO contacts VALUES(?,?,?,?,?) ON CONFLICT(member) DO UPDATE SET
      encrypted=excluded.encrypted,consented=excluded.consented,verified=excluded.verified`,
      id,claim.encrypted,claim.consented,Date.now(),isNew?Date.now():null);
  }
  function throttle(key,max,window) {
    const k=h('rate',key), now=Date.now();
    run('INSERT INTO attempts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN until<=? THEN 1 ELSE hits+1 END, until=CASE WHEN until<=? THEN excluded.until ELSE until END',k,1,now+window,now,now);
    if(get('SELECT hits FROM attempts WHERE key=?',k).hits>max) reject(429,'시도가 많아요. 잠시 후 다시 시도해 주세요.');
  }
  function cookie(res,name,value,ttl) {
    res.setHeader('Set-Cookie',name+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+Math.floor(ttl/1000)+(secure?'; Secure':''));
  }
  function issue(res,kind,ttl,member=null,adminCredential=null) {
    const raw=token(),id=h('session',raw);
    run('INSERT INTO sessions(id,kind,expires,member) VALUES(?,?,?,?)',id,kind,Date.now()+ttl,member);
    if(adminCredential)run('INSERT INTO admin_session_proofs(session,sealed) VALUES(?,?)',id,adminVault.seal(adminCredential,id));
    cookie(res,kind==='admin'?'pc_admin':'pc_user',raw,ttl);
  }
  function sessions(req,admin=false) {
    const name=admin?'pc_admin':'pc_user';
    const v=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
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
      if(!link) {res.writeHead(303,{Location:'/?form=unavailable'});return res.end();}
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
      const s=sessions(req);
      const lostClaim=s?.kind==='verified' && !get('SELECT 1 FROM pending_contacts WHERE session=? AND encrypted IS NOT NULL',s.id);
      if(lostClaim)run('DELETE FROM sessions WHERE id=?',s.id);
      const stage=lostClaim?'gate':s?.kind==='member'?safety.memberStage(s.member):(s?.kind||'gate');
      return ok({stage,nick:s?.nick||'',profile:stage==='member'?get('SELECT '+profileCols+' FROM members WHERE id=?',s.member):null});
    }
    if(!post && p==='/api/regions') return ok(regions);
    if(post && p==='/api/key') {
      throttle('key:'+ip,20,hour/4);
      const code=string(b.code,1,256,'인증키');
      if(config.keyMarker && !code.toLowerCase().includes(config.keyMarker.toLowerCase())) reject(403,'이 앱에 발급된 인증키를 입력해 주세요.');
      const v=await upstream.check(code);
      if(v?.status==='pending') reject(403,'승인 대기 중이에요.');
      if(!registryApproved(v)) reject(403,'승인된 인증키를 확인해 주세요.');
      if(revision!==resetVersion()) reject(409,'서버가 초기화됐어요.');
      const prev=sessions(req);
      if(prev) run('DELETE FROM sessions WHERE id=?',prev.id);
      issue(res,'gate_ok',hour);return ok();
    }
    if(post && p==='/api/identity/start') {
      const s=need(req,'gate_ok');
      if(!config.store || !config.channel) reject(503,'관리자가 통신사 인증을 연결한 뒤 이용할 수 있어요.');
      if(b.disclosure!==policyVersion)reject(400,'이름·전화번호 수집 및 이용 안내를 확인해 주세요.');
      const nick=b.login?'':string(b.nick,1,24,'닉네임');
      if(nick)checkText(nick);
      throttle('identity:'+ip,30,hour);
      const id=randomUUID();
      transaction(db,()=>{
        run('UPDATE sessions SET challenge=?,nick=? WHERE id=?',id,nick,s.id);
        run('INSERT OR REPLACE INTO pending_contacts(session,challenge,consented) VALUES(?,?,?)',s.id,id,Date.now());
      });
      return ok({storeId:config.store,channelKey:config.channel,identityVerificationId:id,redirectUrl:base+'/identity-return',forceRedirect:true,bypass:{danal:{AGELIMIT:19}}});
    }
    if(post && p==='/api/identity/finish') {
      const session=need(req,'gate_ok'), id=session.challenge;
      if(!id || id!==b.id) reject(403,'본인인증을 처음부터 다시 진행해 주세요.');
      const result=await upstream.verify(id,config.store);
      if(config.liveOnly && (result.channel?.type!=='LIVE' || result.channel?.key!==config.channel))
        reject(403,'운영 채널에서 인증한 결과가 필요해요.');
      if(result.id!==id || (result.channel?.key && result.channel.key!==config.channel)) reject(403,'인증 내역이 일치하지 않아요.');
      const info=adultInfo(result), ident=h('DI',info.di);
      const stage=transaction(db,()=>{
        const s=need(req,'gate_ok');
        if(s.challenge!==id) reject(409,'이미 처리된 인증이에요.');
        const consent=get('SELECT consented FROM pending_contacts WHERE session=? AND challenge=?',s.id,id);
        if(!consent)reject(403,'인증 화면에서 개인정보 안내를 다시 확인해 주세요.');
        cooldown(ident);
        const claim={...consent,encrypted:vault.seal(result.verifiedCustomer,ident)};
        const member=get('SELECT id FROM members WHERE identity=?',ident);
        if(member) {
          saveContact(member.id,claim,false);
          run('DELETE FROM sessions WHERE id=?',s.id); issue(res,'member',24*30*hour,member.id);
          return 'member';
        }
        if(safety.restricted(ident))reject(403,'이용 제한 기간에는 가입할 수 없어요.');
        if(!s.nick) reject(404,'가입된 계정이 없어요. 닉네임을 입력하고 가입해 주세요.');
        run('UPDATE pending_contacts SET encrypted=? WHERE session=?',claim.encrypted,s.id);
        run("UPDATE sessions SET kind='verified',identity=?,year=?,gender=?,challenge=NULL WHERE id=?",ident,info.year,info.gender,s.id);
        return 'verified';
      });
      return ok({stage});
    }
    if(post && p==='/api/register') {
      const s=need(req,'verified');cooldown(s.identity);
      if(!areas.has(b.area)) reject(400,'지역을 선택해 주세요.');
      const memo=string(b.memo,1,800,'성향 메모');
      checkText(memo);checkText(s.nick);
      if(b.policy!==policyVersion)reject(400,'이용규칙을 확인하고 동의해 주세요.');
      if(safety.restricted(s.identity))reject(403,'이용 제한 기간에는 가입할 수 없어요.');
      transaction(db,()=>{
        const claim=get('SELECT encrypted,consented FROM pending_contacts WHERE session=?',s.id);
        if(!claim?.encrypted)reject(403,'휴대폰 본인인증을 다시 진행해 주세요.');
        let id=get('SELECT id FROM members WHERE identity=?',s.identity)?.id;
        const isNew=!id;
        if(!id) {
          id=randomUUID();
          run('INSERT INTO members VALUES(?,?,?,?,?,?,?)',id,s.identity,s.nick,s.year,s.gender,b.area,memo);
        }
        saveContact(id,claim,isNew);safety.accept(id,b.policy);
        run('DELETE FROM sessions WHERE id=?',s.id);issue(res,'member',24*30*hour,id);
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
        run('INSERT OR REPLACE INTO cooldowns VALUES(?,?)',m.identity,expires);
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
          SELECT p.id,p.nick,p.area,c.joined,'active' AS status,NULL AS withdrawn,NULL AS expires
          FROM members p LEFT JOIN contacts c ON p.id=c.member
          UNION ALL SELECT id,nick,NULL,NULL,'withdrawn',withdrawn,expires FROM departures WHERE expires>?
        ) ORDER BY status,nick,id LIMIT 51 OFFSET ?`,now,offset);
        return ok({items:members.slice(0,50),more:members.length>50,counts});
      }
      const memberPath=p.match(/^\/api\/admin\/members\/([a-f0-9-]+)$/);
      if(memberPath && !post){
        const m=get(`SELECT p.id,p.nick,p.year,p.gender,p.area,p.memo,p.identity,c.encrypted,c.verified,c.joined
          FROM members p LEFT JOIN contacts c ON c.member=p.id WHERE p.id=?`,memberPath[1]);
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
    secret:env.SECRET,store:env.PORTONE_STORE_ID,channel:env.PORTONE_CHANNEL_KEY,liveOnly:env.NODE_ENV==='production',keyMarker:env.APP_KEY_MARKER});
  server.listen(port,'0.0.0.0',()=>console.log('채팅 서버 시작 ('+port+')'));
}
