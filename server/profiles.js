import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function installProfiles(app,{accounts,authorize,accountProfile,saveAccounts,rooms,onAvatar=()=>{}}) {
  const directory=process.env.SIGUO_AVATARS_DIR||'/mnt/e/junqi-avatars';
  const locks=new Set();
  const filename=id=>path.join(directory,id+'.img');
  app.delete('/api/avatar',async(req,res)=>{
    const username=authorize(req)?.username;
    if(!username)return res.status(401).json({error:'请先登录'});
    if(locks.has(username))return res.status(409).json({error:'头像正在保存，请稍后重试'});
    locks.add(username);const account=accounts[username],old=account.avatar;
    try{delete account.avatar;await saveAccounts.flush();}
    catch(error){account.avatar=old;locks.delete(username);throw error;}
    try{if(old?.id&&/^[-a-f0-9]{36}$/.test(old.id))fs.rmSync(filename(old.id),{force:true});}
    finally{locks.delete(username);}
    onAvatar();res.json({ok:true});
  });
  app.get('/api/profile/:username',(req,res)=>{
    const username=req.params.username, account=accounts[username];
    if(!account||account.status==='pending')return res.status(404).json({error:'用户不存在'});
    res.json({username,...accountProfile(username),createdAt:account.createdAt||null,avatar:account.avatar?.id||null,
      history:account.ratingHistory||[], contests:[...rooms.values()].filter(r=>r.phase==='finished'&&(r.ratedParticipants||r.players).some(p=>(p.username||p.name)===username))
        .map(r=>({code:r.code,name:r.name||r.code,time:r.finishedAt,rated:r.rated&&!r.aborted&&!r.drawn,winner:r.winner})).sort((a,b)=>b.time-a.time)});
  });
  app.patch('/api/profile/signature',async(req,res)=>{
    const username=authorize(req)?.username;if(!username)return res.status(401).json({error:'请先登录'});
    const signature=String(req.body?.signature??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
    if(Buffer.byteLength(signature)>1024)return res.status(400).json({error:'个性签名不能超过 1 KiB'});
    accounts[username].signature=signature;await saveAccounts.flush();res.json({ok:true,signature});
  });
  app.get('/api/avatar/:username',(req,res)=>{
    const avatar=accounts[req.params.username]?.avatar;
    if(!avatar||!/^[-a-f0-9]{36}$/.test(avatar.id))return res.status(404).json({error:'尚未设置头像'});
    try{res.json({type:avatar.type,data:fs.readFileSync(filename(avatar.id)).toString('base64')});}
    catch{res.status(404).json({error:'头像文件不存在'});}
  });
  app.post('/api/avatar',async(req,res)=>{
    const username=authorize(req)?.username;
    if(!username)return res.status(401).json({error:'请先登录'});
    if(locks.has(username))return res.status(409).json({error:'头像正在保存，请稍后重试'});
    const raw=req.body?.data;
    if(typeof raw!=='string'||raw.length>5592408)return res.status(400).json({error:'头像最大 4 MiB'});
    const bytes=Buffer.from(raw,'base64');let type;
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';
    else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';
    else if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))type='image/gif';
    else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')type='image/webp';
    if(!type||bytes.length>4*1024*1024)return res.status(400).json({error:'请选择有效 PNG、JPEG、GIF 或 WebP 头像（最大 4 MiB）'});
    locks.add(username);
    const account=accounts[username], old=account.avatar, next={id:crypto.randomUUID(),type};
    try{
      fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(filename(next.id),bytes,{flag:'wx',mode:0o600});
      account.avatar=next;await saveAccounts.flush();
    }catch(error){account.avatar=old;fs.rmSync(filename(next.id),{force:true});locks.delete(username);return res.status(500).json({error:'头像保存失败，请检查头像目录权限'});}
    try{if(old?.id&&/^[-a-f0-9]{36}$/.test(old.id))fs.rmSync(filename(old.id),{force:true});}
    finally{locks.delete(username);}
    onAvatar();res.json({ok:true,avatar:next.id});
  });
}
