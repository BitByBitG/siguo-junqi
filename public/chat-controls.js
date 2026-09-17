export function copySourceButton(text){
  const button=document.createElement('button');button.type='button';button.className='chat-recall';button.textContent='复制';button.title='复制 Markdown / LaTeX 源码';
  button.onclick=async()=>{
    try{await navigator.clipboard.writeText(String(text??''));button.textContent='已复制';}
    catch{button.textContent='复制失败';}
    setTimeout(()=>{button.textContent='复制';},1600);
  };
  return button;
}
export function renderMutedUsers(panel,users,unmute){
  panel.replaceChildren();panel.hidden=!users.length;
  if(!users.length)return;
  panel.append(document.createTextNode('已禁言：'));
  for(const username of users){
    const button=document.createElement('button');button.type='button';button.className='chat-recall';button.textContent=`${username} ×`;button.title=`解除 ${username} 的禁言`;button.onclick=()=>unmute(username);panel.append(button);
  }
}
