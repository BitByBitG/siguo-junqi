// Coalesce writes, serialize them, and make flush wait for every pending revision.
export function debouncedWriter(write,{interval=500,onError=error=>console.error('[持久化] 写入失败:',error.message)}={}){
  let timer=null,dirty=false,running=null;
  function run(){
    if(running)return running;
    running=(async()=>{
      while(dirty){dirty=false;try{await write();}catch(error){dirty=true;throw error;}}
    })().finally(()=>{running=null;});
    return running;
  }
  function schedule(){
    dirty=true;
    if(!timer){timer=setTimeout(()=>{timer=null;run().catch(onError);},interval);timer.unref?.();}
  }
  schedule.flush=async()=>{
    if(timer){clearTimeout(timer);timer=null;}
    dirty=true;await run();
    if(dirty)await run();
  };
  return schedule;
}
