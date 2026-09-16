import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resetRoomsOnce,writeRoomsArchive,validArchive} from '../server/room-archive.js';
test('reset only once; preserve valid backup when main is corrupt; reject invalid writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'junqi-archive-')),file=path.join(dir,'rooms.json');
 try{
 fs.writeFileSync(file,'移坏了');fs.writeFileSync(file+'.bak','移坏了');resetRoomsOnce(file);
 assert.equal(validArchive(fs.readFileSync(file,'utf8')).rooms.length,0);
 const body=JSON.stringify({version:1,rooms:[{code:'NEWONE'}]});writeRoomsArchive(file,body);resetRoomsOnce(file);assert.equal(fs.readFileSync(file,'utf8'),body);
 writeRoomsArchive(file,body);fs.writeFileSync(file,'移坏了');writeRoomsArchive(file,JSON.stringify({version:1,rooms:[]}));assert.equal(fs.readFileSync(file+'.bak','utf8'),body);
 assert.throws(()=>writeRoomsArchive(file,'broken'));assert.equal(validArchive(fs.readFileSync(file,'utf8')).rooms.length,0);
 assert.ok(!fs.readdirSync(dir).some(n=>n.endsWith('.tmp')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
