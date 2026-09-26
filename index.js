require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const mongoose = require('mongoose');
const { default: makeWASocket, useMultiFileAuthState, delay, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || '';
const IS_RENDER =!!process.env.RENDER;

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DATA_FILE = path.join(__dirname, 'data', 'deployed.json');

['./auth','./data','./media','./sessions'].forEach(d=>{
  if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true});
});
if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(__dirname));
app.use('/media', express.static(path.join(__dirname,'media')));

// ===== MONGODB SETUP =====
let useMongo = false;
let SessionModel = null;

const sessionSchema = new mongoose.Schema({
  number: { type: String, unique: true, required: true },
  session: String,
  sessionId: String, // alias for user.html compatibility
  name: { type: String, default: "User" },
  duration: { type: Number, default: 30 },
  deployedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  expiry: { type: Date, required: true },
  expiresAt: { type: Date }, // alias
  expiryDisplay: String,
  active: { type: Boolean, default: true },
  status: { type: String, default: 'active' },
  id: String
});

async function initMongo(){
  if(!MONGODB_URI) {
    console.log('[DB] Using JSON file');
    return;
  }
  try{
    await mongoose.connect(MONGODB_URI);
    SessionModel = mongoose.model('DeployedBot', sessionSchema);
    useMongo = true;
    console.log('✅ MongoDB Connected');
  }catch(e){
    console.log('❌ MongoDB Failed, using JSON:', e.message);
    useMongo = false;
  }
}

// DB helpers
let sessionsDB = [];
try{ sessionsDB = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch{ sessionsDB=[]; }

async function getDB(){
  if(useMongo && SessionModel){
    try{ return await SessionModel.find({}).lean(); }catch(e){ console.log(e.message); return sessionsDB; }
  }
  try{ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch{ return []; }
}
function saveJSON(){
  if(!useMongo) fs.writeFileSync(DATA_FILE, JSON.stringify(sessionsDB, null, 2));
}

// ===== PAGES =====
app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'deploy.html')));
app.get('/deploy', (req,res)=> res.sendFile(path.join(__dirname,'deploy.html')));
app.get('/users', (req,res)=> res.sendFile(path.join(__dirname,'user.html')));
app.get('/user.html', (req,res)=> res.sendFile(path.join(__dirname,'user.html')));

app.get('/bot-image', (req,res)=>{
  for(let n of ['bot.jpg','bot.jpeg','bot.png','bot_image.png']){
    let p = path.join(__dirname,'media',n);
    if(fs.existsSync(p)) return res.sendFile(p);
  }
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
  res.set('Content-Type','image/png'); res.send(buf);
});

// ===== STATS FOR DEPLOY.HTML =====
app.get('/total-users', async (req,res)=>{
  const db = await getDB();
  const real = db.length;
  const total = real>0? real+1523 : 1523;
  const online = Math.max(12, Math.floor(total*0.05)+(new Date().getSeconds()%8));
  res.json({ total, online, count:total, real });
});

app.get('/deploy-stats', async (req,res)=>{
  const db = await getDB();
  const now=new Date();
  const active=db.filter(s=> new Date(s.expiry||s.expiresAt) > now && s.active!==false && s.status!=='expired').length;
  const expired=db.filter(s=> new Date(s.expiry||s.expiresAt) <= now || s.active===false).length;
  res.json({ total:db.length, active, expired, real:{total:db.length, active, expired} });
});

app.get('/list', async (req,res)=> res.json(await getDB()));
app.get('/health', async (req,res)=> res.json({ok:true, bots:(await getDB()).length, mongo:useMongo}));

// ===== NEW API FOR USER.HTML =====
app.get('/api/users', async (req,res)=>{
  try{
    const db = await getDB();
    const now = new Date();
    // Normalize for user.html
    const normalized = db.map(u=> ({
      number: u.number,
      name: u.name || `User ${u.number.slice(-4)}`,
      sessionId: u.sessionId || u.session || '',
      session: u.session || u.sessionId || '',
      createdAt: u.createdAt || u.deployedAt,
      deployedAt: u.deployedAt || u.createdAt,
      expiresAt: u.expiresAt || u.expiry,
      expiry: u.expiry || u.expiresAt,
      expiryDisplay: u.expiryDisplay || new Date(u.expiry||u.expiresAt).toLocaleDateString('en-GB'),
      status: (new Date(u.expiry||u.expiresAt) <= now || u.active===false)? 'expired' : 'active',
      active: u.active,
      duration: u.duration
    }));
    res.json(normalized);
  }catch(e){ res.status(500).json({error:e.message}) }
});

app.delete('/api/users/:number', async (req,res)=>{
  const num=req.params.number.replace(/[^0-9]/g,'');
  try{
    if(useMongo){
      await SessionModel.deleteOne({number:num});
    }else{
      sessionsDB = sessionsDB.filter(s=> s.number!==num);
      saveJSON();
    }
    stopBotForUser(num);
    console.log(`[DELETE] ${num}`);
    res.json({success:true, message:`Deleted ${num}`});
  }catch(e){ res.status(500).json({error:e.message}) }
});

app.post('/api/users/:number/renew', async (req,res)=>{
  const num=req.params.number.replace(/[^0-9]/g,'');
  try{
    const days = 30;
    let newExpiry;
    if(useMongo){
      const user = await SessionModel.findOne({number:num});
      if(!user) return res.status(404).json({error:"User not found"});
      const base = new Date(user.expiry||user.expiresAt) > new Date()? new Date(user.expiry||user.expiresAt) : new Date();
      newExpiry = new Date(base.getTime() + days*24*60*60*1000);
      user.expiry = newExpiry;
      user.expiresAt = newExpiry;
      user.active = true;
      user.status = 'active';
      await user.save();
    }else{
      const idx = sessionsDB.findIndex(s=> s.number===num);
      if(idx<0) return res.status(404).json({error:"Not found"});
      const base = new Date(sessionsDB[idx].expiry) > new Date()? new Date(sessionsDB[idx].expiry) : new Date();
      newExpiry = new Date(base.getTime() + days*24*60*60*1000);
      sessionsDB[idx].expiry = newExpiry.toISOString();
      sessionsDB[idx].expiresAt = newExpiry.toISOString();
      sessionsDB[idx].active = true;
      sessionsDB[idx].status = 'active';
      saveJSON();
    }
    console.log(`[RENEW] ${num} -> ${newExpiry}`);
    res.json({success:true, newExpiry});
  }catch(e){ res.status(500).json({error:e.message}) }
});

app.get('/api/users/:number/session', async (req,res)=>{
  try{
    const num=req.params.number.replace(/[^0-9]/g,'');
    let user;
    if(useMongo) user = await SessionModel.findOne({number:num});
    else user = sessionsDB.find(s=> s.number===num);
    if(!user) return res.status(404).json({error:"Not found"});
    res.json({sessionId: user.sessionId || user.session});
  }catch(e){ res.status(500).json({error:e.message}) }
});

// ===== PAIR CODE & QR =====
app.get('/code', async (req,res)=>{
  const num=req.query.number?.replace(/[^0-9]/g,'');
  if(!num||num.length<10) return res.status(400).json({error:'Number required (e.g. 26377...)'});
  const id='ETIAS_'+Date.now(); const authFolder=`./auth/${id}`;
  try{
    const {state, saveCreds}=await useMultiFileAuthState(authFolder);
    const sock=makeWASocket({auth:state, logger:pino({level:'silent'}), browser:Browsers.macOS('Chrome')});
    sock.ev.on('creds.update', saveCreds);
    await delay(1200);
    let code=await sock.requestPairingCode(num);
    code=code?.match(/.{1,4}/g)?.join('-')||code;
    res.json({code});
    setTimeout(()=>{try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{}},90000);
  }catch(e){ console.log(e); res.status(500).json({error:'Failed to get pairing code'}); try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} }
});

app.get('/qr-image', async (req,res)=>{
  const id='QR_'+Date.now(); const authFolder=`./auth/${id}`;
  try{
    const {state, saveCreds}=await useMultiFileAuthState(authFolder);
    const sock=makeWASocket({auth:state, logger:pino({level:'silent'}), browser:Browsers.macOS('Chrome')});
    sock.ev.on('creds.update', saveCreds);
    const qrData=await new Promise((resolve,reject)=>{
      let t=setTimeout(()=>reject('timeout'),25000);
      sock.ev.on('connection.update', async u=>{ if(u.qr){ clearTimeout(t); resolve(await qrcode.toDataURL(u.qr)); } });
    });
    res.json({qr:qrData});
    setTimeout(()=>{try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{}},60000);
  }catch(e){ res.status(500).json({error:'QR failed'}); try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} }
});

// ===== DEPLOY LOGIC =====
function startBotForUser(data){
  if(IS_RENDER){ console.log(`[RENDER MODE] Deployed ${data.number} - bot runs on main repo`); return; }
  const BOT_REPO_PATH = path.join(__dirname, '..', 'ETIAS-MINI-BOT');
  const ecoPath=path.join(SESSIONS_DIR,`ecosystem-${data.number}.config.js`);
  const ecoContent=`module.exports={ apps:[{ name:"etias-${data.number}", script:"${path.join(BOT_REPO_PATH,'index.js')}", cwd:"${BOT_REPO_PATH}", env:{ SESSION_ID:\`${(data.session||data.sessionId||'').replace(/`/g,'\\`')}\`, USER_NUMBER:"${data.number}", EXPIRY:"${data.expiry||data.expiresAt}" }, autorestart:true }] }`;
  fs.writeFileSync(ecoPath, ecoContent);
  exec(`pm2 start ${ecoPath} --update-env && pm2 save`, (err)=>{ if(!err) console.log(`[PM2 STARTED] ${data.number}`); else console.log(err.message); });
}

function stopBotForUser(number){
  if(IS_RENDER) return;
  exec(`pm2 stop etias-${number} && pm2 delete etias-${number} && pm2 save`, ()=>{});
  try{ fs.unlinkSync(path.join(SESSIONS_DIR,`ecosystem-${number}.config.js`)); }catch{}
}

app.post('/deploy', async (req,res)=>{
  const { session, userNumber, duration, sessionId } = req.body;
  const finalSession = session || sessionId;
  if(!finalSession ||!finalSession.includes('ETIAS-MINI-BOT')) return res.json({status:false, message:'Invalid SESSION_ID - Must start with ETIAS-MINI-BOT~'});
  if(!userNumber) return res.json({status:false, message:'Number required'});

  const cleanNumber=userNumber.replace(/[^0-9]/g,'');
  const days=Math.min(Math.max(parseInt(duration)||30,1),365);
  const expiry=new Date(); expiry.setDate(expiry.getDate()+days);

  const deployData={
    id: Date.now().toString(),
    number: cleanNumber,
    name: `User ${cleanNumber.slice(-4)}`,
    session: finalSession,
    sessionId: finalSession,
    duration: days,
    deployedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    expiry: expiry.toISOString(),
    expiresAt: expiry.toISOString(),
    expiryDisplay: expiry.toLocaleDateString('en-GB'),
    active: true,
    status: 'active'
  };

  try{
    if(useMongo && SessionModel){
      await SessionModel.findOneAndUpdate({number:cleanNumber}, deployData, {upsert:true, new:true});
    }else{
      let existing=sessionsDB.find(s=> s.number===cleanNumber);
      if(existing){ stopBotForUser(cleanNumber); Object.assign(existing, deployData); }else{ sessionsDB.push(deployData); }
      saveJSON();
    }
    startBotForUser(deployData);
    res.json({status:true, success:true, expiry:deployData.expiryDisplay, number:cleanNumber});
  }catch(e){ console.log(e); res.json({status:false, message:e.message}); }
});

app.post('/expire/:number', async (req,res)=>{
  const num=req.params.number.replace(/[^0-9]/g,'');
  try{
    if(useMongo && SessionModel){
      await SessionModel.findOneAndUpdate({number:num},{active:false, status:'expired'});
    }else{
      const idx=sessionsDB.findIndex(s=> s.number===num);
      if(idx>=0){ sessionsDB[idx].active=false; sessionsDB[idx].status='expired'; saveJSON(); }
    }
    stopBotForUser(num);
    res.json({status:true});
  }catch(e){ res.json({status:false, error:e.message}) }
});

// ===== AUTO START BOTS =====
async function startDeployedBots(){
  await initMongo();
  const db = await getDB();
  console.log(`[AUTO-START] Found ${db.length} bots | Mongo:${useMongo} | Mode:${IS_RENDER?'RENDER':'VPS'}`);
  for(let bot of db){
    const exp = new Date(bot.expiry||bot.expiresAt);
    if(exp < new Date()) { console.log(`[SKIP EXPIRED] ${bot.number}`); continue; }
    if(bot.active===false || bot.status==='expired') continue;
    console.log(`[BOT START] ${bot.number} till ${exp.toLocaleDateString()}`);
    startBotForUser(bot);
  }
}
startDeployedBots();

// Expiry checker every 1 hour
setInterval(async ()=>{
  const now=new Date();
  const db = await getDB();
  for(let s of db){
    const exp = new Date(s.expiry||s.expiresAt);
    if(s.active!==false && exp <= now){
      console.log(`[EXPIRED] ${s.number}`);
      if(useMongo && SessionModel) await SessionModel.updateOne({number:s.number},{active:false, status:'expired'});
      else { const idx=sessionsDB.findIndex(x=>x.number===s.number); if(idx>=0){ sessionsDB[idx].active=false; sessionsDB[idx].status='expired'; } }
      stopBotForUser(s.number);
    }
  }
  if(!useMongo) saveJSON();
}, 1000*60*60);

app.listen(PORT, '0.0.0.0', ()=> console.log(`✅ ETIAS DEPLOY PANEL :${PORT} ${IS_RENDER?'[RENDER MODE]':'[VPS MODE]'} Mongo:${!!MONGODB_URI}`));
