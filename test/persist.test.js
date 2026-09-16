import test from 'node:test';
import assert from 'node:assert/strict';
import {debouncedWriter} from '../server/persist.js';
test('flush waits for an in-flight write and the latest pending revision',async()=>{
  let value=1,release,started;const written=[];
  const began=new Promise(resolve=>started=resolve);
  const writer=debouncedWriter(async()=>{const snapshot=value;if(snapshot===1){started();await new Promise(resolve=>release=resolve);}written.push(snapshot);});
  const first=writer.flush();await began;value=2;
  let finished=false;const second=writer.flush().then(()=>finished=true);
  await Promise.resolve();assert.equal(finished,false);release();
  await Promise.all([first,second]);assert.deepEqual(written,[1,2]);assert.equal(finished,true);
});
test('explicit flush reports disk errors to callers',async()=>{
  const writer=debouncedWriter(async()=>{throw Error('disk failure');});
  await assert.rejects(writer.flush(),/disk failure/);
});
