import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function atomicWrite(file,body){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const temp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
 let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export function validArchive(body){const value=JSON.parse(body);if(!value||value.version!==1||!Array.isArray(value.rooms))throw Error('房间存档格式错误');return value;}
export function resetRoomsOnce(file){
 const marker=file+'.reset-2.5.11';
 if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8')==='done')return;
 atomicWrite(marker,'pending');
 const empty=JSON.stringify({version:1,rooms:[]});
 atomicWrite(file,empty);atomicWrite(file+'.bak',empty);
 try{fs.unlinkSync(file+'.tmp');}catch(e){if(e.code!=='ENOENT')throw e;}
 atomicWrite(marker,'done');
 console.warn('[持久化] 已完成一次性对局历史清理（2.5.11），账号及其他数据不受影响');
}
export function writeRoomsArchive(file,body){
 validArchive(body);
 if(fs.existsSync(file)){
  const previous=fs.readFileSync(file,'utf8');
  try{validArchive(previous);atomicWrite(file+'.bak',previous);}catch(e){console.warn('[持久化] 未使用损坏的主存档覆盖备份:',e.message);}
 }
 atomicWrite(file,body);
}
