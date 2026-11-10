let mode=new URLSearchParams(location.search).get('game')||localStorage.getItem('junqi-admin-mode')||'junqi';
function select(value){mode=['holdem','ddz'].includes(value)?value:'junqi';localStorage.setItem('junqi-admin-mode',mode);document.querySelector('#account-form').hidden=mode!=='junqi';
 for(const section of document.querySelectorAll('.admin-shell > section'))section.hidden=(section.dataset.adminMode||'junqi')!==mode;
 for(const b of document.querySelectorAll('[data-admin-mode-button]'))b.setAttribute('aria-pressed',String(b.dataset.adminModeButton===mode));
 for(const a of document.querySelectorAll('#admin-directory a')){const target=document.querySelector(a.getAttribute('href'));a.hidden=target?.hidden||false;}
 window.dispatchEvent(new CustomEvent('junqi-admin-mode',{detail:mode}));
}
for(const b of document.querySelectorAll('[data-admin-mode-button]'))b.onclick=()=>select(b.dataset.adminModeButton);
new MutationObserver(()=>select(mode)).observe(document.querySelector('#admin-directory'),{childList:true});select(mode);
