import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function installImages(app,{authorize,canEnter,isMuted,isAdmin=()=>false,canUpload=()=>true,canGroup=()=>false}){
  const directory=process.env.SIGUO_PICTURES_DIR||'/mnt/e/pictures';
  const indexFile=path.join(directory,'siguo-images.json');
  const quota=Math.min(1024*1024*1024,Math.max(1024,Number(process.env.SIGUO_PICTURES_LIMIT_BYTES)||1024*1024*1024)),maxImage=8*1024*1024;
  let images=[];
  let indexHealthy=true;
  if(fs.existsSync(indexFile)){
    try{
      const parsed=JSON.parse(fs.readFileSync(indexFile,'utf8'));
      if(!Array.isArray(parsed))throw Error('图床索引格式错误');
      images=parsed;
    }catch(error){
      try{
        const backup=`${indexFile}.corrupt-${new Date().toISOString().replace(/[:.]/g,'-')}`;
        fs.renameSync(indexFile,backup);
        console.error(`[图床] 索引损坏，已移到 ${backup}，将重建空索引:`,error?.message||error);
      }catch(backupError){
        console.error('[图床] 索引损坏且无法备份，将忽略旧索引继续启动:',error?.message||error,backupError?.message||backupError);
      }
      images=[];
      indexHealthy=false;
    }
  }
  const filename=id=>path.join(directory,`siguo-${id}.img`);
  images=images.filter(image=>/^[0-9a-f-]{36}$/.test(image.id)&&fs.existsSync(filename(image.id)));
  const save=()=>{fs.writeFileSync(indexFile+'.tmp',JSON.stringify(images),{mode:0o600});fs.renameSync(indexFile+'.tmp',indexFile);};
  function prune(){
    let total=images.reduce((sum,item)=>sum+item.size,0);
    while(images.length&&total+Buffer.byteLength(JSON.stringify(images))>quota){const old=images.shift();fs.rmSync(filename(old.id),{force:true});total-=old.size;}
  }
  if(fs.existsSync(directory)){
    // Only delete orphan files when the index was parsed successfully. If the index is corrupt,
    // preserve image bytes for manual recovery instead of treating every image as an orphan.
    if(indexHealthy){
      const known=new Set(images.map(image=>path.basename(filename(image.id))));
      for(const name of fs.readdirSync(directory))if(/^siguo-[0-9a-f-]{36}\.img$/.test(name)&&!known.has(name))fs.rmSync(path.join(directory,name));
      prune();if(fs.existsSync(indexFile))save();
    }
  }
  function permitted(req,scope){const user=authorize(req);if(!user)return false;if(scope==='lobby')return true;if(scope.startsWith('group:'))return canGroup(user.username,scope.slice(6));return !user.admin&&canEnter(user.username,scope);}
  // These routes precede the generic admin middleware, so authorize every request here.
  app.get('/api/admin/images',(req,res)=>{
    if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});
    res.json({items:[...images].reverse(),total:images.length,bytes:images.reduce((n,i)=>n+i.size,0),quota});
  });
  app.get('/api/admin/images/:id',(req,res)=>{
    if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});
    const image=images.find(item=>item.id===req.params.id);
    if(!image)return res.status(404).json({error:'图片已删除'});
    try{res.json({type:image.type,data:fs.readFileSync(filename(image.id)).toString('base64')});}
    catch{res.status(404).json({error:'图片文件不存在'});}
  });
  app.delete('/api/admin/images',(req,res)=>{
    if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});
    const ids=new Set(Array.isArray(req.body?.ids)?req.body.ids:[]);if(!ids.size)return res.status(400).json({error:'请选择要删除的图片'});
    try{for(const image of images.filter(item=>ids.has(item.id)))fs.rmSync(filename(image.id),{force:true});images=images.filter(item=>!ids.has(item.id));save();res.json({ok:true});}
    catch{res.status(500).json({error:'删除失败，请检查图床目录权限'});}
  });
  app.delete('/api/admin/images/:id',(req,res)=>{
    if(!isAdmin(req))return res.status(403).json({error:'需要管理员权限'});
    const image=images.find(item=>item.id===req.params.id);
    if(!image)return res.status(404).json({error:'图片已删除'});
    try{
      fs.rmSync(filename(image.id),{force:true});images=images.filter(item=>item!==image);save();
      res.json({ok:true});
    }catch{res.status(500).json({error:'删除失败，请检查图床目录权限'});}
  });
  app.post('/api/images',(req,res)=>{
    const user=authorize(req),scope=String(req.body?.scope||'');
    if(!user||!permitted(req,scope))return res.status(403).json({error:'请登录并进入对应聊天室'});
    if(!canUpload(user.username))return res.status(403).json({error:'你所在分组已暂停图床功能'});
    if(isMuted(user.username,scope))return res.status(403).json({error:'你已被禁言'});
    try{
      const raw=req.body.data;if(typeof raw!=='string'||raw.length>Math.ceil(maxImage/3)*4)throw Error('图片最大 8 MiB');
      const data=Buffer.from(raw,'base64');let type;
      if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';
      else if(data[0]===255&&data[1]===216&&data[2]===255)type='image/jpeg';
      else if(['GIF87a','GIF89a'].includes(data.subarray(0,6).toString()))type='image/gif';
      else if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')type='image/webp';
      if(!type)throw Error('仅支持 PNG、JPEG、GIF、WebP 图片');
      fs.mkdirSync(directory,{recursive:true});
      const image={id:crypto.randomUUID(),scope,owner:user.username,time:Date.now(),size:data.length,type};
      fs.writeFileSync(filename(image.id),data,{flag:'wx',mode:0o600});images.push(image);
      prune();save();
      if(!images.includes(image))throw Error('图片超过图床当前容量上限');
      res.json({url:`/api/images/${image.id}`});
    }catch(error){res.status(400).json({error:error.code?'图片目录不可写，请检查 /mnt/e/pictures 权限':error.message});}
  });
  app.get('/api/images/:id',(req,res)=>{
    const image=images.find(item=>item.id===req.params.id);
    if(!image)return res.status(404).json({error:'图片已过期或被清理'});
    if(!permitted(req,image.scope))return res.status(403).json({error:'无权查看图片，请登录并进入对应房间'});
    try{res.json({type:image.type,data:fs.readFileSync(filename(image.id)).toString('base64')});}
    catch{res.status(404).json({error:'图片已删除'});}
  });
}
