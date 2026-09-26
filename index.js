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
const OWNER_KEY = process.env.OWNER_KEY || 'ETIAS7788';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';
const IS_RENDER = !!process.env.RENDER;

const BOT_REPO_PATH = path.join(__dirname, '..', 'ETIAS-MINI-BOT');
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

// ===== MONGODB =====
let useMongo = false;
let SessionModel = null;

if(MONGODB_URI){
  mongoose.connect(MONGODB_URI).then(()=>{
    console.log('✅ MongoDB Connected');
    useMongo = true;
  }).catch(e=> console.log('❌ MongoDB Failed, using JSON:', e.message));
}

const sessionSchema = new mongoose.Schema({
  number: { type: String, unique: true },
  session: String,
  duration: Number,
  deployedAt: String,
  expiry: String,
  expiryDisplay: String,
  active: { type: Boolean, default: true },
  id: String
});
SessionModel = mongoose.model('DeployedBot', sessionSchema);

// DB helpers (Mongo + JSON fallback)
let sessionsDB = [];
try{ sessionsDB = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch{ sessionsDB=[]; }

async function getDB(){
  if(useMongo){
    try{ return await SessionModel.find({}); }catch{ return sessionsDB; }
  }
  try{ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }catch{ return []; }
}
async function getDBSync(){
  if(useMongo){
    try{ const data = await SessionModel.find({}); return data; }catch{}
  }
  return sessionsDB;
}
function saveDB(){ 
  if(!useMongo) fs.writeFileSync(DATA_FILE, JSON.stringify(sessionsDB, null, 2)); 
}

// Pages
app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'deploy.html')));
app.get('/deploy', (req,res)=> res.sendFile(path.join(__dirname,'deploy.html')));
app.get('/deploy-panel', (req,res)=> res.sendFile(path.join(__dirname,'deploy.html')));

app.get('/bot-image', (req,res)=>{
  for(let n of ['bot.jpg','bot.jpeg','bot.png','bot_image.png']){
    let p = path.join(__dirname,'media',n);
    if(fs.existsSync(p)) return res.sendFile(p);
  }
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
  res.set('Content-Type','image/png'); res.send(buf);
});

app.get('/total-users', async (req,res)=>{
  const db = await getDB(); const real = db.length;
  const total = real>0? real+1523 : 1523;
  const online = Math.max(12, Math.floor(total*0.05)+(new Date().getSeconds()%8));
  res.json({ total, online, count:total, real });
});

app.get('/deploy-stats', async (req,res)=>{
  const db = await getDB();
  const now=new Date();
  const active=db.filter(s=> new Date(s.expiry)>now && s.active!==false).length;
  const expired=db.filter(s=> new Date(s.expiry)<=now || s.active===false).length;
  res.json({ total:db.length, active, expired, real:{total:db.length, active, expired} });
});

app.get('/list', async (req,res)=> res.json(await getDB()));
app.get('/health', async (req,res)=> res.json({ok:true, bots:(await getDB()).length, mongo:useMongo}));

app.get('/code', async (req,res)=>{
  const num=req.query.number?.replace(/[^0-9]/g,'');
  if(!num||num.length<10) return res.status(400).json({error:'Number required'});
  const id='ETIAS_'+Date.now(); const authFolder=`./auth/${id}`;
  try{
    const {state, saveCreds}=await useMultiFileAuthState(authFolder);
    const sock=makeWASocket({auth:state, logger:pino({level:'silent'}), browser:Browsers.macOS('Chrome')});
    sock.ev.on('creds.update', saveCreds); await delay(1200);
    let code=await sock.requestPairingCode(num); code=code?.match(/.{1,4}/g)?.join('-')||code;
    res.json({code});
    setTimeout(()=>{try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{}},90000);
  }catch(e){ res.status(500).json({error:'Failed'}); try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} }
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

function startBotForUser(data){
  if(IS_RENDER){ console.log(`[RENDER] Deployed ${data.number}`); return; }
  const ecoPath=path.join(SESSIONS_DIR,`ecosystem-${data.number}.config.js`);
  const ecoContent=`module.exports={ apps:[{ name:"etias-${data.number}", script:"${path.join(BOT_REPO_PATH,'index.js')}", cwd:"${BOT_REPO_PATH}", env:{ SESSION_ID:\`${data.session.replace(/`/g,'\\`')}\`, USER_NUMBER:"${data.number}", EXPIRY:"${data.expiry}" }, autorestart:true }] }`;
  fs.writeFileSync(ecoPath, ecoContent);
  exec(`pm2 start ${ecoPath} --update-env && pm2 save`, (err)=>{ if(!err) console.log(`[PM2 STARTED] ${data.number}`); });
}
function stopBotForUser(number){
  if(IS_RENDER) return;
  exec(`pm2 stop etias-${number} && pm2 delete etias-${number} && pm2 save`, ()=>{});
  try{ fs.unlinkSync(path.join(SESSIONS_DIR,`ecosystem-${number}.config.js`)); }catch{}
}

app.post('/deploy', async (req,res)=>{
  const { session, userNumber, duration } = req.body;
  if(!session || !session.includes('ETIAS-MINI-BOT')) return res.json({status:false, message:'Invalid SESSION_ID'});
  if(!userNumber) return res.json({status:false, message:'Number required'});
  const cleanNumber=userNumber.replace(/[^0-9]/g,'');
  const days=Math.min(Math.max(parseInt(duration)||30,1),365);
  const expiry=new Date(); expiry.setDate(expiry.getDate()+days);
  const deployData={ id: Date.now().toString(), number:cleanNumber, session, duration:days, deployedAt:new Date().toISOString(), expiry:expiry.toISOString(), expiryDisplay:expiry.toLocaleDateString('en-GB'), active:true };

  if(useMongo){
    await SessionModel.findOneAndUpdate({number:cleanNumber}, deployData, {upsert:true, new:true});
  }else{
    let existing=sessionsDB.find(s=> s.number===cleanNumber);
    if(existing){ stopBotForUser(cleanNumber); Object.assign(existing, deployData); }else{ sessionsDB.push(deployData); }
    saveDB();
  }
  startBotForUser(deployData);
  res.json({status:true, success:true, expiry:deployData.expiryDisplay, number:cleanNumber});
});

app.post('/expire/:number', async (req,res)=>{
  const num=req.params.number.replace(/[^0-9]/g,'');
  if(useMongo){
    await SessionModel.findOneAndUpdate({number:num},{active:false});
  }else{
    const idx=sessionsDB.findIndex(s=> s.number===num);
    if(idx>=0){ sessionsDB[idx].active=false; saveDB(); }
  }
  stopBotForUser(num);
  res.json({status:true});
});

async function startDeployedBots(){
  // Wait for mongo
  if(MONGODB_URI) await new Promise(r=> setTimeout(r,3000));
  const db = await getDB();
  console.log(`[AUTO-START] Found ${db.length} bots Mongo:${useMongo}`);
  for(let bot of db){
    if(new Date(bot.expiry) < new Date()) continue;
    if(bot.active===false) continue;
    console.log(`[BOT] Starting: ${bot.number}`);
    startBotForUser(bot);
  }
}
startDeployedBots();

setInterval(async ()=>{
  const now=new Date(); 
  const db = await getDB();
  for(let s of db){
    if(s.active && new Date(s.expiry)<=now){
      if(useMongo) await SessionModel.updateOne({number:s.number},{active:false});
      else { s.active=false; }
      stopBotForUser(s.number);
    }
  }
  if(!useMongo) saveDB();
}, 1000*60*60);

app.listen(PORT, '0.0.0.0', ()=> console.log(`✅ ETIAS DEPLOY PANEL :${PORT} ${IS_RENDER?'[RENDER MODE]':'[VPS MODE]'} Mongo:${!!MONGODB_URI}`));
