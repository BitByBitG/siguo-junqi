import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {emojis as EMOJIS} from '../public/emojis.js';

export function installArticles(app,{file,authorize,accountProfile,isAdmin,isMuted,canPublish,useQuota}){
  let articles=[];
  try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(parsed))articles=parsed;}catch{}
  const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(articles,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const clean=(value,max)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max);
  const view=(a,user,full=false)=>({id:a.id,title:a.title,author:a.author,time:a.time,updatedAt:a.updatedAt,body:full?a.body:undefined,preview:a.body.split(/\r?\n/).slice(0,5).join('\n'),score:Object.values(a.votes||{}).reduce((n,v)=>n+v,0),viewerVote:a.votes?.[user]||0,profile:accountProfile(a.author),comments:full?(a.comments||[]).map(m=>({...m,...accountProfile(m.name)})):undefined,muted:full?(a.muted||[]):undefined});
  const userOf=req=>authorize(req)?.username;
  const find=req=>articles.find(a=>a.id===req.params.id);
  app.get('/api/articles',(req,res)=>{const u=userOf(req);res.json([...articles].sort((a,b)=>b.time-a.time).map(a=>view(a,u)));});
  app.get('/api/articles/:id',(req,res)=>{const a=find(req);if(!a)return res.status(404).json({error:'文章不存在'});res.json(view(a,userOf(req),true));});
  app.post('/api/articles',(req,res)=>{
    const user=userOf(req);if(!user)return res.status(401).json({error:'请先登录'});
    const allowed=canPublish(user);if(!allowed.ok)return res.status(403).json({error:allowed.error});
    const title=clean(req.body?.title,100),body=clean(req.body?.body,262144);if(!title||!body)return res.status(400).json({error:'标题和正文不能为空'});
    if(Buffer.byteLength(body)>256*1024)return res.status(400).json({error:'文章正文不能超过 256 KiB'});
    const a={id:crypto.randomUUID(),title,body,author:user,time:Date.now(),updatedAt:Date.now(),votes:{},comments:[],muted:[]};articles.push(a);useQuota(user);save();res.status(201).json({id:a.id});
  });
  app.post('/api/articles/:id/vote',(req,res)=>{const user=userOf(req),a=find(req);if(!user)return res.status(401).json({error:'请先登录'});if(!a)return res.status(404).json({error:'文章不存在'});const vote=Number(req.body?.vote);if(![-1,0,1].includes(vote))return res.status(400).json({error:'投票值无效'});a.votes||={};if(vote)a.votes[user]=vote;else delete a.votes[user];save();res.json({score:Object.values(a.votes).reduce((n,v)=>n+v,0),viewerVote:vote});});
  app.post('/api/articles/:id/comments',(req,res)=>{const user=userOf(req),a=find(req);if(!user)return res.status(401).json({error:'请先登录'});if(!a)return res.status(404).json({error:'文章不存在'});if(isMuted(user)||(a.muted||[]).includes(user))return res.status(403).json({error:'你已被禁言'});const text=clean(req.body?.text,8000);if(!text)return res.status(400).json({error:'评论不能为空'});a.comments||=[];a.comments.push({id:crypto.randomUUID(),name:user,text,time:Date.now(),reactions:{}});a.comments=a.comments.slice(-100);save();res.json({ok:true});});
  app.post('/api/articles/:id/comments/action',(req,res)=>{
    const user=userOf(req),a=find(req);if(!user)return res.status(401).json({error:'请先登录'});if(!a)return res.status(404).json({error:'文章不存在'});const action=String(req.body?.action||''),admin=isAdmin(req),m=(a.comments||[]).find(x=>x.id===req.body?.messageId);
    if(action==='recall'){if(!m||m.recalled)return res.status(404).json({error:'评论不存在'});if(m.name!==user||Date.now()-m.time>300000)return res.status(403).json({error:'只能在 5 分钟内撤回自己的评论'});m.text='[已撤回]';m.recalled=true;delete m.reactions;}
    else if(action==='delete'){if(!admin)return res.status(403).json({error:'需要管理员权限'});a.comments=(a.comments||[]).filter(x=>x.id!==req.body?.messageId);}
    else if(action==='mute'||action==='unmute'){if(!admin)return res.status(403).json({error:'需要管理员权限'});const target=clean(req.body?.username,16);a.muted||=[];const i=a.muted.indexOf(target);if(action==='mute'&&i<0)a.muted.push(target);if(action==='unmute'&&i>=0)a.muted.splice(i,1);}
    else if(action==='react'){if(!m||m.recalled)return res.status(404).json({error:'评论不存在'});const emoji=String(req.body?.emoji||'');if(!EMOJIS.includes(emoji))return res.status(400).json({error:'不支持的表情'});m.reactions||={};const users=m.reactions[emoji]||=[],i=users.indexOf(user);if(i>=0)users.splice(i,1);else users.push(user);if(users.length)m.reactions[emoji]=users;else delete m.reactions[emoji];}
    else return res.status(400).json({error:'未知操作'});save();res.json({ok:true});
  });
  app.get('/api/admin/articles',(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});res.json([...articles].sort((a,b)=>b.time-a.time).map(a=>({...view(a,null),bytes:Buffer.byteLength(a.body)})));});
  app.delete('/api/admin/articles/:id',(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});const n=articles.length;articles=articles.filter(a=>a.id!==req.params.id);if(articles.length===n)return res.status(404).json({error:'文章不存在'});save();res.json({ok:true});});
}
