const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type, x-owner-secret, x-device-token, x-platform-key',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  'Content-Type':'application/json; charset=utf-8'
};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const text=(body,status=400)=>new Response(String(body),{status,headers:cors});
const cleanSlug=v=>String(v||'').toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,60);
const toMin=t=>{const [h,m]=String(t||'00:00').split(':').map(Number);return h*60+m};
const pad=n=>String(n).padStart(2,'0');
const fromMin=n=>`${pad(Math.floor(n/60))}:${pad(n%60)}`;
const overlaps=(a,b,c,d)=>a<d&&c<b;
const nowIso=()=>new Date().toISOString();
const isoDate=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;

async function business(env,slug){return env.DB.prepare('SELECT * FROM businesses WHERE slug=?').bind(slug).first()}
async function ensureLicenseTables(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS business_subscriptions(
      slug TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      plan_code TEXT NOT NULL DEFAULT 'barberia',
      cohort TEXT NOT NULL DEFAULT 'standard',
      founder_slot INTEGER,
      intro_cycles_total INTEGER NOT NULL DEFAULT 0,
      intro_cycles_used INTEGER NOT NULL DEFAULT 0,
      discount_pct REAL NOT NULL DEFAULT 0,
      list_price_cents INTEGER NOT NULL DEFAULT 1990000,
      effective_price_cents INTEGER NOT NULL DEFAULT 1990000,
      currency TEXT NOT NULL DEFAULT 'ARS',
      current_period_start TEXT,
      current_period_end TEXT,
      grace_until TEXT,
      suspended_at TEXT,
      archived_at TEXT,
      deletion_review_at TEXT,
      cancellation_requested_at TEXT,
      cancellation_effective_at TEXT,
      cancellation_request_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      note TEXT
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON business_subscriptions(status,current_period_end)')
  ]);
}
async function ensureAdminTables(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_business_meta(
      slug TEXT PRIMARY KEY,
      owner TEXT,
      phone TEXT,
      notes TEXT,
      start_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS platform_payments(
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ARS',
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_platform_payments_slug ON platform_payments(slug,paid_at)')
  ]);
}

async function subscription(env,slug){
  await ensureLicenseTables(env);
  const row=await env.DB.prepare('SELECT * FROM business_subscriptions WHERE slug=?').bind(slug).first();
  if(row)return row;
  return {slug,status:'ACTIVE',plan_code:'legacy',effective_price_cents:0,currency:'ARS',current_period_end:null,grace_until:null};
}
function platformOk(req,env){
  const key=String(req.headers.get('x-platform-key')||'');
  return Boolean(env.PLATFORM_ADMIN_KEY&&key&&key===String(env.PLATFORM_ADMIN_KEY));
}
function licenseAllowsOps(status){
  return ['ACTIVE','GRACE','CANCELLATION_PENDING'].includes(String(status||'ACTIVE'));
}
async function requireActiveLicense(env,slug){
  const lic=await subscription(env,slug);
  return {ok:licenseAllowsOps(lic.status),license:lic};
}
function parsedConfig(row){try{return JSON.parse(row?.config_json||'{}')}catch{return {}}}
function ownerOk(req,row){return Boolean(row&&req.headers.get('x-owner-secret')&&req.headers.get('x-owner-secret')===row.owner_secret)}
async function ensureDeviceTables(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS device_pairings(
      code TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS device_tokens(
      token TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT,
      revoked_at TEXT
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_device_tokens_slug ON device_tokens(slug,revoked_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pairings_slug ON device_pairings(slug,expires_at)')
  ]);
}
async function operationalOk(req,env,row,slug){
  if(ownerOk(req,row))return true;
  const token=String(req.headers.get('x-device-token')||'').trim();
  if(!token)return false;
  await ensureDeviceTables(env);
  const found=await env.DB.prepare('SELECT token FROM device_tokens WHERE token=? AND slug=? AND revoked_at IS NULL').bind(token,slug).first();
  if(!found)return false;
  env.DB.prepare('UPDATE device_tokens SET last_seen=? WHERE token=?').bind(nowIso(),token).run().catch(()=>{});
  return true;
}
function pairingCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=new Uint8Array(6);crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>chars[b%chars.length]).join('');
}
async function ensureRecoveryTable(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_recovery(
      code TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_recovery_slug ON admin_recovery(slug,expires_at)')
  ]);
}
function ownerSecret(){return `own_${crypto.randomUUID()}_${crypto.randomUUID()}`}
function serviceBy(cfg,id){return (cfg.services||[]).find(s=>s.id===id)}

function buildSlots(cfg,date,serviceId,dbBookings=[]){
  const bs=cfg.bookingSettings||{},srv=serviceBy(cfg,serviceId);
  if(!srv||srv.onlineEnabled===false||bs.enabled===false)return[];
  const d=new Date(date+'T00:00:00Z'),dow=d.getUTCDay();
  if(!(bs.workingDays||[]).map(Number).includes(dow))return[];
  const today=new Date(),todayDate=isoDate(today);
  const max=new Date();max.setUTCDate(max.getUTCDate()+Number(bs.maxAdvanceDays||30));
  if(date<todayDate||date>isoDate(max))return[];
  const localBlocks=(cfg.localBlocks||[]).filter(b=>b.date===date&&b.time&&['pending','confirmed'].includes(b.status||'confirmed'));
  const importedIds=new Set(localBlocks.map(b=>b.onlineBookingId).filter(Boolean));
  const onlineBlocks=dbBookings.filter(b=>!importedIds.has(b.id)&&['pending','confirmed'].includes(b.status)).map(b=>({id:b.id,serviceId:b.service_id,date:b.date,time:b.time,duration:Number(serviceBy(cfg,b.service_id)?.duration||30),status:b.status,onlineBookingId:b.id}));
  const blocks=[...localBlocks,...onlineBlocks];
  const start=toMin(bs.openTime||'09:00'),close=toMin(bs.closeTime||'19:00'),step=Math.max(5,Number(bs.slotStep||15)),duration=Math.max(1,Number(srv.duration||30));
  const minTs=Date.now()+Math.max(0,Number(bs.minAdvanceHours||0))*3600000;
  const out=[];
  for(let t=start;t+duration<=close;t+=step){
    const when=new Date(date+'T'+fromMin(t)+':00-03:00').getTime();
    if(when<minTs)continue;
    const overlap=blocks.filter(b=>{const bsrv=serviceBy(cfg,b.serviceId),st=toMin(b.time),en=st+Number(b.duration||bsrv?.duration||30);return overlaps(t,t+duration,st,en)});
    let ok=overlap.length===0,overbook=false;
    if(overlap.length&&srv.allowOverbook){
      const allAllow=overlap.every(b=>Boolean(serviceBy(cfg,b.serviceId)?.allowOverbook));
      if(allAllow){const limits=[Math.max(1,Number(srv.maxConcurrent||1)),...overlap.map(b=>Math.max(1,Number(serviceBy(cfg,b.serviceId)?.maxConcurrent||1)))];const limit=Math.min(...limits);ok=overlap.length<limit;overbook=ok}
    }
    if(ok)out.push({time:fromMin(t),end:fromMin(t+duration),overbook});
  }
  return out;
}


function todayArgentina(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function timeArgentina(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||'';
  return `${get('hour')}:${get('minute')}`;
}
function phoneKey(v){return String(v||'').replace(/\D/g,'')}
function nameKey(v){return String(v||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ')}
async function ensureOperationalTables(env){
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS queue_entries(
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      appointment_id TEXT,
      client_name TEXT,
      client_phone TEXT,
      service_id TEXT NOT NULL,
      arrival TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      source TEXT,
      business_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_queue_slug_date ON queue_entries(slug,business_date,status)')
  ]);
}
async function ownerState(env,slug){
  await ensureOperationalTables(env);
  const from=todayArgentina();
  const [bq,qq]=await Promise.all([
    env.DB.prepare("SELECT * FROM bookings WHERE slug=? AND date>=? ORDER BY date ASC,time ASC,created_at ASC").bind(slug,from).all(),
    env.DB.prepare("SELECT * FROM queue_entries WHERE slug=? AND business_date=? ORDER BY created_at ASC").bind(slug,from).all()
  ]);
  return {
    bookings:(bq.results||[]).map(b=>({id:b.id,serviceId:b.service_id,serviceName:b.service_name,date:b.date,time:b.time,status:b.status,price:b.price,clientName:b.client_name||'',clientPhone:b.client_phone||'',note:b.note||'',createdAt:b.created_at||''})),
    queue:(qq.results||[]).map(q=>({id:q.id,appointmentId:q.appointment_id||'',clientName:q.client_name||'',clientPhone:q.client_phone||'',serviceId:q.service_id,arrival:q.arrival||'',status:q.status||'waiting',source:q.source||'shared',businessDate:q.business_date,updatedAt:q.updated_at||''})),
    serverTime:nowIso()
  };
}
async function upsertOwnerAppointment(env,row,body){
  const slug=cleanSlug(body.slug),cfg=parsedConfig(row),serviceId=String(body.serviceId||''),srv=serviceBy(cfg,serviceId);
  if(!srv)return {error:'Servicio no disponible.',status:400};
  const id=String(body.id||crypto.randomUUID()),date=String(body.date||''),time=String(body.time||''),allowed=['pending','confirmed','cancelled','no_show','completed'];
  const status=allowed.includes(String(body.status||''))?String(body.status):'pending';
  if(!date)return {error:'Falta la fecha.',status:400};
  const current=await env.DB.prepare('SELECT * FROM bookings WHERE id=? AND slug=?').bind(id,slug).first();
  if(['pending','confirmed'].includes(status)&&time){
    const cleanBlocks=(cfg.localBlocks||[]).filter(b=>String(b.onlineBookingId||'')!==id&&String(b.id||'')!==id);
    const q=await env.DB.prepare("SELECT id,service_id,date,time,status FROM bookings WHERE slug=? AND date=? AND id<>? AND status IN ('pending','confirmed')").bind(slug,date,id).all();
    const slot=buildSlots({...cfg,localBlocks:cleanBlocks},date,serviceId,q.results||[]).find(x=>x.time===time);
    if(!slot)return {error:'Ese horario ya no está disponible. Elegí otro.',status:409};
  }
  const created=current?.created_at||nowIso(),clientName=String(body.clientName||current?.client_name||'').trim(),clientPhone=String(body.clientPhone||current?.client_phone||'').trim(),note=String(body.note??current?.note??'').trim();
  await env.DB.prepare(`INSERT INTO bookings(id,slug,service_id,service_name,date,time,status,price,client_name,client_phone,note,imported,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET service_id=excluded.service_id,service_name=excluded.service_name,date=excluded.date,time=excluded.time,status=excluded.status,price=excluded.price,client_name=excluded.client_name,client_phone=excluded.client_phone,note=excluded.note,imported=1`)
    .bind(id,slug,serviceId,srv.name,date,time,status,Number(body.price??srv.price??0),clientName,clientPhone,note,1,created).run();
  return {ok:true,id,status,date,time,serviceId};
}
async function upsertQueue(env,slug,body){
  await ensureOperationalTables(env);
  const id=String(body.id||crypto.randomUUID()),now=nowIso(),businessDate=String(body.businessDate||todayArgentina()),status=['waiting','in_service','done','cancelled'].includes(String(body.status||''))?String(body.status):'waiting';
  const existing=await env.DB.prepare('SELECT created_at FROM queue_entries WHERE id=? AND slug=?').bind(id,slug).first();
  await env.DB.prepare(`INSERT INTO queue_entries(id,slug,appointment_id,client_name,client_phone,service_id,arrival,status,source,business_date,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET appointment_id=excluded.appointment_id,client_name=excluded.client_name,client_phone=excluded.client_phone,service_id=excluded.service_id,arrival=excluded.arrival,status=excluded.status,source=excluded.source,business_date=excluded.business_date,updated_at=excluded.updated_at`)
    .bind(id,slug,String(body.appointmentId||''),String(body.clientName||'').trim(),String(body.clientPhone||'').trim(),String(body.serviceId||''),String(body.arrival||''),status,String(body.source||'shared'),businessDate,existing?.created_at||now,now).run();
  return {ok:true,id,status,businessDate,updatedAt:now};
}

async function telegram(env,row,cfg,b){
  if(!env.TELEGRAM_BOT_TOKEN||!cfg.bookingSettings?.telegramEnabled||!row.telegram_chat_id)return {sent:false};
  const msg=`🔔 Nuevo turno\n${b.clientName}\n${b.serviceName}\n${b.date} · ${b.time}\n${b.clientPhone||''}${b.note?`\nNota: ${b.note}`:''}`;
  try{
    const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:row.telegram_chat_id,text:msg})});
    return {sent:r.ok};
  }catch{return {sent:false}}
}

export default {
 async fetch(req,env){
  if(req.method==='OPTIONS')return new Response('',{headers:cors});
  const u=new URL(req.url),path=u.pathname;
  try{
    if(path==='/api/version'&&req.method==='GET'){
      const legacy=await business(env,'brian-barber');
      if(legacy&&legacy.business_name==='Barber'){
        const deletes=[
          ['business_subscriptions','slug'],
          ['admin_business_meta','slug'],
          ['platform_payments','slug'],
          ['queue_entries','slug'],
          ['bookings','slug'],
          ['device_pairings','slug'],
          ['device_tokens','slug'],
          ['admin_recovery','slug']
        ];
        for(const [table,col] of deletes){
          try{await env.DB.prepare(`DELETE FROM ${table} WHERE ${col}=?`).bind('brian-barber').run()}catch{}
        }
        await env.DB.prepare("DELETE FROM businesses WHERE slug=? AND business_name='Barber'").bind('brian-barber').run();
      }
      return json({ok:true,version:'v23-licenses'});
    }
    if(path==='/api/license'&&req.method==='GET'){
      const slug=cleanSlug(u.searchParams.get('slug'));if(!slug)return text('Falta negocio.');
      const lic=await subscription(env,slug);
      return json({slug,status:lic.status||'ACTIVE',plan:lic.plan_code||'barberia',priceCents:Number(lic.effective_price_cents||0),currency:lic.currency||'ARS',currentPeriodEnd:lic.current_period_end||null,graceUntil:lic.grace_until||null});
    }
    if(path==='/api/platform/subscriptions'&&req.method==='GET'){
      if(!platformOk(req,env))return text('No autorizado.',403);
      await ensureLicenseTables(env);
      const q=await env.DB.prepare('SELECT * FROM business_subscriptions ORDER BY created_at DESC').all();
      return json({subscriptions:q.results||[]});
    }
    if(path==='/api/platform/subscription-upsert'&&req.method==='POST'){
      if(!platformOk(req,env))return text('No autorizado.',403);
      const b=await req.json(),slug=cleanSlug(b.slug);if(!slug)return text('Falta negocio.');
      const biz=await business(env,slug);if(!biz)return text('Negocio no encontrado.',404);
      await ensureLicenseTables(env);
      const now=nowIso(),existing=await env.DB.prepare('SELECT * FROM business_subscriptions WHERE slug=?').bind(slug).first();
      const allowed=['ACTIVE','GRACE','SUSPENDED','ARCHIVED','CANCELLATION_PENDING','CANCELLED','DELETION_REVIEW','CLOSED','REFUNDED'];
      const status=allowed.includes(String(b.status||''))?String(b.status):(existing?.status||'ACTIVE');
      const price=Number.isFinite(Number(b.effectivePriceCents))?Number(b.effectivePriceCents):Number(existing?.effective_price_cents||1990000);
      const periodStart=String(b.currentPeriodStart||existing?.current_period_start||'')||null;
      const periodEnd=String(b.currentPeriodEnd||existing?.current_period_end||'')||null;
      const graceUntil=String(b.graceUntil||existing?.grace_until||'')||null;
      const suspendedAt=status==='SUSPENDED'?(existing?.suspended_at||now):null;
      if(existing){
        await env.DB.prepare('UPDATE business_subscriptions SET status=?,effective_price_cents=?,current_period_start=?,current_period_end=?,grace_until=?,suspended_at=?,updated_at=? WHERE slug=?').bind(status,price,periodStart,periodEnd,graceUntil,suspendedAt,now,slug).run();
      }else{
        await env.DB.prepare('INSERT INTO business_subscriptions(slug,status,plan_code,cohort,list_price_cents,effective_price_cents,currency,current_period_start,current_period_end,grace_until,suspended_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(slug,status,String(b.planCode||'barberia'),String(b.cohort||'standard'),price,price,'ARS',periodStart,periodEnd,graceUntil,suspendedAt,now,now).run();
      }
      const lic=await subscription(env,slug);return json({ok:true,license:lic});
    }
    if(path==='/api/platform/businesses'&&req.method==='GET'){
      if(!platformOk(req,env))return text('No autorizado.',403);
      await ensureLicenseTables(env);
      await ensureAdminTables(env);
      const [bq,pq]=await Promise.all([
        env.DB.prepare(`SELECT
          b.slug,b.business_name,b.owner_secret,b.config_json,b.updated_at,
          m.owner,m.phone,m.notes,m.start_date,m.created_at AS admin_created_at,
          s.status,s.plan_code,s.effective_price_cents,s.current_period_start,s.current_period_end,s.grace_until
          FROM businesses b
          LEFT JOIN admin_business_meta m ON m.slug=b.slug
          LEFT JOIN business_subscriptions s ON s.slug=b.slug
          ORDER BY COALESCE(m.created_at,b.updated_at) DESC`).all(),
        env.DB.prepare('SELECT * FROM platform_payments ORDER BY paid_at DESC,created_at DESC').all()
      ]);
      const businesses=(bq.results||[]).map(r=>{
        const cfg=parsedConfig(r);
        return {
          slug:r.slug,
          name:r.business_name,
          owner:r.owner||'',
          phone:r.phone||'',
          notes:r.notes||'',
          ownerSecret:r.owner_secret,
          plan:r.plan_code||'barberia',
          priceCents:Number(r.effective_price_cents||0),
          start:r.current_period_start||r.start_date||'',
          renewal:r.current_period_end||'',
          status:r.status||'ACTIVE',
          graceUntil:r.grace_until||null,
          services:cfg.services||[],
          bookingSettings:cfg.bookingSettings||{},
          createdAt:r.admin_created_at||r.updated_at||''
        };
      });
      return json({
        businesses,
        payments:(pq.results||[]).map(p=>({
          id:p.id,
          slug:p.slug,
          amountCents:Number(p.amount_cents||0),
          currency:p.currency||'ARS',
          paidAt:p.paid_at
        }))
      });
    }

    if(path==='/api/platform/business-create'&&req.method==='POST'){
      if(!platformOk(req,env))return text('No autorizado.',403);
      const b=await req.json();
      const slug=cleanSlug(b.slug||b.name);
      const name=String(b.name||'').trim();
      if(!slug||!name)return text('Falta nombre o slug.');
      if(await business(env,slug))return text('Ese slug ya existe en el servidor.',409);

      await ensureLicenseTables(env);
      await ensureAdminTables(env);

      const now=nowIso();
      const secret=ownerSecret();
      const services=Array.isArray(b.services)?b.services:[];
      const bookingSettings={
        enabled:true,
        openTime:String(b.openTime||'09:00'),
        closeTime:String(b.closeTime||'19:00'),
        slotStep:15,
        minAdvanceHours:2,
        maxAdvanceDays:30,
        approvalMode:'auto',
        workingDays:[1,2,3,4,5,6],
        telegramEnabled:false
      };
      const cfg={services,bookingSettings,localBlocks:[]};
      const price=Math.max(0,Number(b.priceCents||1990000));
      const start=String(b.start||'')||null;
      const renewal=String(b.renewal||'')||null;

      await env.DB.batch([
        env.DB.prepare('INSERT INTO businesses(slug,owner_secret,business_name,config_json,telegram_chat_id,updated_at) VALUES(?,?,?,?,?,?)')
          .bind(slug,secret,name,JSON.stringify(cfg),'',now),
        env.DB.prepare('INSERT INTO admin_business_meta(slug,owner,phone,notes,start_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .bind(slug,String(b.owner||'').trim(),String(b.phone||'').trim(),String(b.notes||'').trim(),start,now,now),
        env.DB.prepare('INSERT INTO business_subscriptions(slug,status,plan_code,cohort,list_price_cents,effective_price_cents,currency,current_period_start,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .bind(slug,'ACTIVE',String(b.plan||'barberia'),'standard',price,price,'ARS',start,renewal,now,now)
      ]);

      return json({
        ok:true,
        business:{
          slug,name,ownerSecret:secret,status:'ACTIVE',
          priceCents:price,start,renewal,services,bookingSettings
        }
      });
    }

    if(path==='/api/platform/payment-record'&&req.method==='POST'){
      if(!platformOk(req,env))return text('No autorizado.',403);
      const b=await req.json();
      const slug=cleanSlug(b.slug);
      if(!slug)return text('Falta negocio.');
      if(!await business(env,slug))return text('Negocio no encontrado.',404);
      await ensureLicenseTables(env);
      await ensureAdminTables(env);
      const now=nowIso();
      const paidAt=String(b.paidAt||now);
      const amountCents=Math.max(0,Math.round(Number(b.amountCents||0)));
      const renewal=String(b.renewal||'')||null;
      const id=crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO platform_payments(id,slug,amount_cents,currency,paid_at,created_at) VALUES(?,?,?,?,?,?)')
          .bind(id,slug,amountCents,'ARS',paidAt,now),
        env.DB.prepare("UPDATE business_subscriptions SET status='ACTIVE',current_period_end=COALESCE(?,current_period_end),suspended_at=NULL,updated_at=? WHERE slug=?")
          .bind(renewal,now,slug)
      ]);
      return json({ok:true,id});
    }

    if(path==='/api/recovery/code'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);
      if(!row)return text('Negocio no encontrado.',404);
      if(!env.TELEGRAM_BOT_TOKEN||!row.telegram_chat_id)return text('Este negocio no tiene Telegram vinculado para recuperar el acceso.',409);
      await ensureRecoveryTable(env);
      const now=new Date(),expires=new Date(now.getTime()+10*60*1000).toISOString();
      await env.DB.prepare('DELETE FROM admin_recovery WHERE slug=? OR expires_at<?').bind(slug,now.toISOString()).run();
      let code='';
      for(let i=0;i<6;i++){
        code=pairingCode();
        try{await env.DB.prepare('INSERT INTO admin_recovery(code,slug,expires_at,used_at,created_at) VALUES(?,?,?,?,?)').bind(code,slug,expires,null,now.toISOString()).run();break}catch{code=''}
      }
      if(!code)return text('No pude generar el código de recuperación.',500);
      return json({ok:true,slug,code,expiresAt:expires,businessName:row.business_name,bot:'@Mi_negocio_barberia_bot'});
    }
    if(path==='/api/recovery/complete'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),code=String(body.code||'').trim().toUpperCase();
      if(!slug||!code)return text('Falta negocio o código.');
      const row=await business(env,slug);if(!row)return text('Negocio no encontrado.',404);
      if(!env.TELEGRAM_BOT_TOKEN||!row.telegram_chat_id)return text('Este negocio no tiene Telegram vinculado para recuperar el acceso.',409);
      await ensureRecoveryTable(env);
      const rec=await env.DB.prepare('SELECT * FROM admin_recovery WHERE code=? AND slug=?').bind(code,slug).first();
      if(!rec)return text('Código incorrecto o vencido.',404);
      if(rec.used_at)return text('Este código ya fue usado. Generá uno nuevo.',409);
      if(new Date(rec.expires_at).getTime()<Date.now())return text('Este código venció. Generá uno nuevo.',410);
      const tr=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=-100&limit=100&timeout=0`);
      const tj=await tr.json();
      if(!tr.ok||!tj.ok)return text('Telegram no respondió correctamente.',502);
      const updates=Array.isArray(tj.result)?tj.result:[];
      let found=false;
      for(let i=updates.length-1;i>=0;i--){
        const msg=updates[i]?.message||updates[i]?.edited_message;
        if(!msg?.chat?.id)continue;
        if(String(msg.chat.id)!==String(row.telegram_chat_id))continue;
        const raw=String(msg.text||'').trim().toUpperCase().replace(/\s+/g,' ');
        if(raw===`RECUPERAR ${code}`){found=true;break}
      }
      if(!found)return text(`Todavía no recibí RECUPERAR ${code} desde el Telegram vinculado.`,409);
      const secret=ownerSecret(),now=nowIso();
      await env.DB.batch([
        env.DB.prepare('UPDATE businesses SET owner_secret=?, updated_at=? WHERE slug=?').bind(secret,now,slug),
        env.DB.prepare('UPDATE admin_recovery SET used_at=? WHERE code=? AND slug=?').bind(now,code,slug)
      ]);
      const cfg=parsedConfig(row);
      try{await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:row.telegram_chat_id,text:`✅ Acceso recuperado para ${row.business_name}.`})})}catch{}
      return json({ok:true,slug,businessName:row.business_name,ownerSecret:secret,telegramChatId:String(row.telegram_chat_id||''),services:cfg.services||[],bookingSettings:cfg.bookingSettings||{}});
    }
    if(path==='/api/owner/device-pair-code'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);
      if(!ownerOk(req,row))return text('No autorizado.',403);
      await ensureDeviceTables(env);
      const now=new Date(),expires=new Date(now.getTime()+10*60*1000).toISOString();
      await env.DB.prepare('DELETE FROM device_pairings WHERE slug=? OR expires_at<?').bind(slug,now.toISOString()).run();
      let code='';
      for(let i=0;i<6;i++){
        code=pairingCode();
        try{await env.DB.prepare('INSERT INTO device_pairings(code,slug,expires_at,used_at,created_at) VALUES(?,?,?,?,?)').bind(code,slug,expires,null,now.toISOString()).run();break}catch{code=''}
      }
      if(!code)return text('No pude generar el código de vinculación.',500);
      return json({ok:true,slug,code,expiresAt:expires,businessName:row.business_name});
    }
    if(path==='/api/device/pair'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),code=String(body.code||'').trim().toUpperCase();
      if(!slug||!code)return text('Falta negocio o código.');
      await ensureDeviceTables(env);
      const pair=await env.DB.prepare('SELECT * FROM device_pairings WHERE code=? AND slug=?').bind(code,slug).first();
      if(!pair)return text('Código incorrecto o vencido.',404);
      if(pair.used_at)return text('Este código ya fue usado. Generá uno nuevo.',409);
      if(new Date(pair.expires_at).getTime()<Date.now())return text('Este código venció. Generá uno nuevo.',410);
      const row=await business(env,slug);if(!row)return text('Negocio no encontrado.',404);
      const token=`dev_${crypto.randomUUID()}_${crypto.randomUUID()}`,now=nowIso(),label=String(body.label||'Dispositivo vinculado').trim().slice(0,80);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO device_tokens(token,slug,label,created_at,last_seen,revoked_at) VALUES(?,?,?,?,?,NULL)').bind(token,slug,label,now,now),
        env.DB.prepare('UPDATE device_pairings SET used_at=? WHERE code=? AND slug=?').bind(now,code,slug)
      ]);
      const cfg=parsedConfig(row);
      return json({ok:true,slug,businessName:row.business_name,deviceToken:token,services:cfg.services||[],bookingSettings:cfg.bookingSettings||{}});
    }
    if(path==='/api/owner/state'&&req.method==='GET'){
      const slug=cleanSlug(u.searchParams.get('slug')),row=await business(env,slug);if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      const gate=await requireActiveLicense(env,slug);if(!gate.ok)return json({error:'Suscripción suspendida.',license:{status:gate.license.status}},423);
      return json(await ownerState(env,slug));
    }
    if(path==='/api/owner/appointment-upsert'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      const result=await upsertOwnerAppointment(env,row,{...body,slug});if(result.error)return text(result.error,Number(result.status)||400);return json(result);
    }
    if(path==='/api/owner/queue-upsert'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      const cfg=parsedConfig(row);if(!serviceBy(cfg,String(body.serviceId||'')))return text('Servicio no disponible.',400);
      return json(await upsertQueue(env,slug,body));
    }
    if(path==='/api/checkin/arrive'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!row)return text('Negocio no encontrado.',404);const gate=await requireActiveLicense(env,slug);if(!gate.ok)return text('Negocio temporalmente suspendido.',423);
      const clientName=String(body.clientName||'').trim(),clientPhone=String(body.clientPhone||'').trim();
      if(!clientName||!clientPhone)return text('Completá nombre y teléfono.');
      await ensureOperationalTables(env);
      const date=todayArgentina(),q=await env.DB.prepare("SELECT * FROM bookings WHERE slug=? AND date=? AND status IN ('pending','confirmed') ORDER BY time ASC,created_at ASC").bind(slug,date).all();
      const phone=phoneKey(clientPhone),name=nameKey(clientName),candidates=(q.results||[]).filter(b=>phoneKey(b.client_phone)===phone);
      let booking=null;
      if(candidates.length===1)booking=candidates[0];
      else if(candidates.length>1)booking=candidates.find(b=>nameKey(b.client_name)===name)||null;
      if(!booking)return text('No encontramos un turno activo para hoy con esos datos. Revisá el nombre y el teléfono o avisá en recepción.',404);
      const existing=await env.DB.prepare("SELECT * FROM queue_entries WHERE slug=? AND business_date=? AND appointment_id=? AND status IN ('waiting','in_service') LIMIT 1").bind(slug,date,booking.id).first();
      if(existing)return json({ok:true,already:true,id:existing.id,appointmentId:booking.id,serviceId:booking.service_id,serviceName:booking.service_name,time:booking.time,status:existing.status});
      const qr=await upsertQueue(env,slug,{id:crypto.randomUUID(),appointmentId:booking.id,clientName:booking.client_name||clientName,clientPhone:booking.client_phone||clientPhone,serviceId:booking.service_id,arrival:timeArgentina(),status:'waiting',source:'public_checkin',businessDate:date});
      if(String(booking.status)==='pending')await env.DB.prepare("UPDATE bookings SET status='confirmed' WHERE id=? AND slug=?").bind(booking.id,slug).run();
      return json({ok:true,already:false,id:qr.id,appointmentId:booking.id,serviceId:booking.service_id,serviceName:booking.service_name,time:booking.time,status:'waiting'});
    }
    if(path==='/api/checkin/walkin'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!row)return text('Negocio no encontrado.',404);const gate=await requireActiveLicense(env,slug);if(!gate.ok)return text('Negocio temporalmente suspendido.',423);
      const cfg=parsedConfig(row),serviceId=String(body.serviceId||''),srv=serviceBy(cfg,serviceId);if(!srv)return text('Servicio no disponible.',400);
      const clientName=String(body.clientName||'').trim(),clientPhone=String(body.clientPhone||'').trim();if(!clientName)return text('Ingresá tu nombre.');
      await ensureOperationalTables(env);
      const date=todayArgentina(),active=await env.DB.prepare("SELECT * FROM queue_entries WHERE slug=? AND business_date=? AND status IN ('waiting','in_service') ORDER BY created_at ASC").bind(slug,date).all();
      const p=phoneKey(clientPhone),n=nameKey(clientName);
      const duplicate=(active.results||[]).find(q=>q.service_id===serviceId&&((p&&phoneKey(q.client_phone)===p&&nameKey(q.client_name)===n)||(!p&&nameKey(q.client_name)===n)));
      if(duplicate)return json({ok:true,already:true,id:duplicate.id,serviceId,serviceName:srv.name,status:duplicate.status});
      const qr=await upsertQueue(env,slug,{id:crypto.randomUUID(),appointmentId:'',clientName,clientPhone,serviceId,arrival:timeArgentina(),status:'waiting',source:'public_walkin',businessDate:date});
      return json({ok:true,already:false,id:qr.id,serviceId,serviceName:srv.name,status:'waiting'});
    }
    if(path==='/api/business/sync'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),secret=req.headers.get('x-owner-secret')||'';
      if(!slug||!secret)return text('Falta slug o clave de propietario.');
      const existing=await business(env,slug);
      if(existing&&!ownerOk(req,existing))return text('Clave de propietario incorrecta.',403);
      const cfg={services:body.services||[],bookingSettings:body.bookingSettings||{},localBlocks:body.localBlocks||[]};
      const now=nowIso();
      const telegramChatId=String(body.telegramChatId||existing?.telegram_chat_id||'');
      if(existing)await env.DB.prepare('UPDATE businesses SET business_name=?, config_json=?, telegram_chat_id=?, updated_at=? WHERE slug=?').bind(body.businessName||'Barbería',JSON.stringify(cfg),telegramChatId,now,slug).run();
      else await env.DB.prepare('INSERT INTO businesses(slug,owner_secret,business_name,config_json,telegram_chat_id,updated_at) VALUES(?,?,?,?,?,?)').bind(slug,secret,body.businessName||'Barbería',JSON.stringify(cfg),telegramChatId,now).run();
      return json({ok:true,slug});
    }
    if(path==='/api/public-config'&&req.method==='GET'){
      const slug=cleanSlug(u.searchParams.get('slug')),row=await business(env,slug);if(!row)return text('Agenda no encontrada.',404);
      const cfg=parsedConfig(row),lic=await subscription(env,slug),bs={...(cfg.bookingSettings||{})};
      if(!licenseAllowsOps(lic.status))bs.enabled=false;
      return json({slug,businessName:row.business_name,services:cfg.services||[],bookingSettings:bs,licenseStatus:lic.status||'ACTIVE'});
    }
    if(path==='/api/availability'&&req.method==='GET'){
      const slug=cleanSlug(u.searchParams.get('slug')),date=u.searchParams.get('date')||'',serviceId=u.searchParams.get('serviceId')||'',row=await business(env,slug);if(!row)return text('Agenda no encontrada.',404);const gate=await requireActiveLicense(env,slug);if(!gate.ok)return text('Agenda suspendida.',423);
      const cfg=parsedConfig(row),q=await env.DB.prepare("SELECT id,service_id,date,time,status FROM bookings WHERE slug=? AND date=? AND status IN ('pending','confirmed')").bind(slug,date).all();
      return json({slots:buildSlots(cfg,date,serviceId,q.results||[])});
    }
    if(path==='/api/bookings'&&req.method==='POST'){
      const b=await req.json(),slug=cleanSlug(b.slug),row=await business(env,slug);if(!row)return text('Agenda no encontrada.',404);const gate=await requireActiveLicense(env,slug);if(!gate.ok)return text('Agenda suspendida.',423);
      const cfg=parsedConfig(row),srv=serviceBy(cfg,b.serviceId);if(!srv||srv.onlineEnabled===false)return text('Servicio no disponible.',400);
      const q=await env.DB.prepare("SELECT id,service_id,date,time,status FROM bookings WHERE slug=? AND date=? AND status IN ('pending','confirmed')").bind(slug,b.date).all();
      const slot=buildSlots(cfg,b.date,b.serviceId,q.results||[]).find(x=>x.time===b.time);if(!slot)return text('Ese horario ya no está disponible. Elegí otro.',409);
      if(!String(b.clientName||'').trim()||!String(b.clientPhone||'').trim())return text('Faltan nombre o teléfono.');
      const id=crypto.randomUUID(),status=cfg.bookingSettings?.approvalMode==='manual'?'pending':'confirmed',created=nowIso();

      const clientName=String(b.clientName).trim(),clientPhone=String(b.clientPhone).trim();
      const saved=await env.DB.prepare(`INSERT INTO bookings
        (id,slug,service_id,service_name,date,time,status,price,client_name,client_phone,note,imported,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (
          SELECT 1 FROM bookings
          WHERE slug=? AND service_id=? AND date=? AND time=?
            AND status IN ('pending','confirmed')
            AND lower(trim(client_name))=lower(?) AND trim(client_phone)=?
        )`).bind(id,slug,srv.id,srv.name,b.date,b.time,status,Number(srv.price||0),clientName,clientPhone,String(b.note||'').trim(),0,created,slug,srv.id,b.date,b.time,clientName,clientPhone).run();
      if(!saved.meta?.changes)return text('Ya existe una reserva para esta persona, servicio y horario.',409);

      await telegram(env,row,cfg,{...b,serviceName:srv.name});
      return json({ok:true,id,status});
    }
    if(path==='/api/owner/booking-update'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),id=String(body.id||''),row=await business(env,slug);
      if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      if(!id)return text('Falta el identificador de la reserva.');
      const current=await env.DB.prepare('SELECT * FROM bookings WHERE id=? AND slug=?').bind(id,slug).first();
      if(!current)return text('Reserva no encontrada.',404);
      const cfg=parsedConfig(row),serviceId=String(body.serviceId||current.service_id||''),srv=serviceBy(cfg,serviceId);
      if(!srv)return text('Servicio no disponible.',400);
      const date=String(body.date||current.date||''),time=String(body.time??current.time??''),allowed=['pending','confirmed','cancelled','no_show','completed'];
      const status=allowed.includes(String(body.status||''))?String(body.status):String(current.status||'confirmed');
      const active=['pending','confirmed'].includes(status);
      const changedSlot=date!==String(current.date||'')||time!==String(current.time||'')||serviceId!==String(current.service_id||'')||!['pending','confirmed'].includes(String(current.status||''));
      const cleanBlocks=(cfg.localBlocks||[]).filter(b=>String(b.onlineBookingId||'')!==id);
      if(active&&time&&changedSlot){
        const cfgCheck={...cfg,localBlocks:cleanBlocks};
        const q=await env.DB.prepare("SELECT id,service_id,date,time,status FROM bookings WHERE slug=? AND date=? AND id<>? AND status IN ('pending','confirmed')").bind(slug,date,id).all();
        const slot=buildSlots(cfgCheck,date,serviceId,q.results||[]).find(x=>x.time===time);
        if(!slot)return text('Ese horario ya no está disponible. Elegí otro.',409);
      }
      await env.DB.prepare('UPDATE bookings SET service_id=?, service_name=?, date=?, time=?, status=?, price=? WHERE id=? AND slug=?').bind(serviceId,srv.name,date,time,status,Number(srv.price||0),id,slug).run();
      cfg.localBlocks=cleanBlocks;
      await env.DB.prepare('UPDATE businesses SET config_json=?, updated_at=? WHERE slug=?').bind(JSON.stringify(cfg),nowIso(),slug).run();
      return json({ok:true,id,status,date,time,serviceId});
    }
    if(path==='/api/owner/bookings'&&req.method==='GET'){
      const slug=cleanSlug(u.searchParams.get('slug')),row=await business(env,slug);if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      const q=await env.DB.prepare('SELECT * FROM bookings WHERE slug=? AND date>=? ORDER BY date ASC,time ASC,created_at ASC').bind(slug,todayArgentina()).all();
      return json({bookings:(q.results||[]).map(b=>({id:b.id,serviceId:b.service_id,serviceName:b.service_name,date:b.date,time:b.time,status:b.status,price:b.price,clientName:b.client_name,clientPhone:b.client_phone,note:b.note,createdAt:b.created_at}))});
    }
    if(path==='/api/owner/ack'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!await operationalOk(req,env,row,slug))return text('No autorizado.',403);
      await env.DB.prepare('UPDATE bookings SET imported=1 WHERE id=? AND slug=?').bind(body.id,slug).run();
      return json({ok:true});
    }
    if(path==='/api/owner/telegram-pair'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),code=String(body.code||'').trim().toUpperCase(),row=await business(env,slug);
      if(!ownerOk(req,row))return text('No autorizado.',403);
      if(!env.TELEGRAM_BOT_TOKEN)return text('Falta configurar TELEGRAM_BOT_TOKEN en el backend.',500);
      if(!code)return text('Falta el código de vinculación.');
      const tr=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?limit=100&timeout=0`);
      const tj=await tr.json();
      if(!tr.ok||!tj.ok)return text('Telegram no respondió correctamente.',502);
      const updates=Array.isArray(tj.result)?tj.result:[];
      let found=null;
      for(let i=updates.length-1;i>=0;i--){
        const msg=updates[i]?.message||updates[i]?.edited_message;
        if(!msg?.chat?.id)continue;
        const raw=String(msg.text||'').trim();
        const normalized=raw.toUpperCase();
        if(normalized===`VINCULAR ${code}`||normalized===code||normalized===`/START ${code}`){found=msg;break}
      }
      if(!found)return json({ok:false,error:`No encontré el código ${code}. Abrí @Mi_negocio_barberia_bot y enviá exactamente: VINCULAR ${code}`},404);
      const chatId=String(found.chat.id),now=nowIso();
      await env.DB.prepare('UPDATE businesses SET telegram_chat_id=?, updated_at=? WHERE slug=?').bind(chatId,now,slug).run();
      const name=found.chat.first_name||found.chat.title||found.chat.username||'';
      try{await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:`✅ Telegram vinculado a ${row.business_name}. A partir de ahora vas a recibir acá las nuevas reservas.`})})}catch{}
      return json({ok:true,chatId,name});
    }
    if(path==='/api/owner/test-telegram'&&req.method==='POST'){
      const body=await req.json(),slug=cleanSlug(body.slug),row=await business(env,slug);if(!ownerOk(req,row))return text('No autorizado.',403);const cfg=parsedConfig(row);
      await telegram(env,row,cfg,{clientName:'Prueba',serviceName:'Reserva online',date:'—',time:'—',clientPhone:'',note:'Telegram conectado correctamente'});return json({ok:true});
    }
    return text('Not found',404);
  }catch(e){return text(e?.stack||e?.message||String(e),500)}
 }
};