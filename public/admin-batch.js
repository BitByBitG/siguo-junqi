export async function runBatch(ids,action){
  const results=[];
  for(const id of ids){try{await action(id);results.push({id,ok:true});}catch(error){results.push({id,ok:false,error:error.message});}}
  return results;
}
export function addSelection(row,id){
  const input=document.createElement('input');input.type='checkbox';input.className='admin-pick';input.value=id;input.setAttribute('aria-label',`选择 ${id}`);row.prepend(input);
}
export function installBatch(list,actions,refresh,status){
  const bar=document.createElement('div');bar.className='admin-batch-toolbar';
  const all=document.createElement('input');all.type='checkbox';all.setAttribute('aria-label','全选');
  const label=document.createElement('label');label.append(all,document.createTextNode('全选'));
  const count=document.createElement('span');count.className='batch-count';
  const picks=()=>[...list.querySelectorAll('.admin-pick')];
  const selected=()=>picks().filter(p=>p.checked).map(p=>p.value);
  const buttons=[];const sync=()=>{const n=selected().length,total=picks().length;count.textContent=`已选 ${n} / ${total}`;all.checked=total>0&&n===total;all.indeterminate=n>0&&n<total;for(const b of buttons)b.disabled=!n;};
  all.onchange=()=>{picks().forEach(p=>p.checked=all.checked);sync();};
  list.onchange=sync;bar.append(label,count);
  for(const {text,run,danger}of actions){
    const b=document.createElement('button');b.type='button';b.textContent=text;if(danger)b.className='danger-text';buttons.push(b);bar.append(b);
    b.onclick=async()=>{
      const ids=selected();if(!ids.length||!confirm(`${text}：共 ${ids.length} 项，确定继续？${danger?'删除后无法通过此页面恢复。':''}`))return;
      const controls=[...list.querySelectorAll('button,input,select')];controls.forEach(c=>c.disabled=true);
      const results=await runBatch(ids,run),failed=results.filter(r=>!r.ok);
      await refresh();
      status.textContent=`${text}：成功 ${results.length-failed.length}，失败 ${failed.length}${failed.length?'；'+failed.map(r=>`${r.id}：${r.error}`).join('；'):''}`;
    };
  }
  list.prepend(bar);sync();
}
