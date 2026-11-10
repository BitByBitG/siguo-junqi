export const rank=c=>{const x=c%54;return x===52?16:x===53?17:(x%13===0?14:x%13===1?15:x%13+1);};
export const sortCards=a=>[...a].sort((a,b)=>rank(a)-rank(b)||a-b);
const sequence=a=>a.length>0&&a.at(-1)<=14&&a.every((x,i)=>!i||x===a[i-1]+1);
export function classify(cards,max=3){
 if(!Array.isArray(cards)||!cards.length)return null;const m=new Map();for(const c of cards)m.set(rank(c),(m.get(rank(c))||0)+1);const g=[...m].sort((a,b)=>a[0]-b[0]),n=cards.length,result=(type,high,len=1)=>({type,high,len,n});
 if((max===3&&n===2&&m.has(16)&&m.has(17))||(max===4&&n===4&&m.get(16)===2&&m.get(17)===2))return result('rocket',17);
 if(g.length===1){const [r,k]=g[0];if(k===1)return result('single',r);if(k===2&&(r<16||max===4))return result('pair',r);if(k===3&&r<16)return result('triple',r);if(k>=4&&k<=(max===4?8:4)&&r<16)return result('bomb',r,k);}
 if(n>=5&&g.every(x=>x[1]===1)&&sequence(g.map(x=>x[0])))return result('straight',g.at(-1)[0],n);
 if(n>=6&&n%2===0&&g.every(x=>x[1]===2)&&sequence(g.map(x=>x[0])))return result('pairs',g.at(-1)[0],n/2);
 if(n===4&&max===3&&g.some(x=>x[1]===3))return result('triple-single',g.find(x=>x[1]===3)[0]);
 if(n===5&&g.length===2&&g.some(x=>x[1]===3)&&g.some(x=>x[1]===2))return result('triple-pair',g.find(x=>x[1]===3)[0]);
 if(max===3&&g.some(x=>x[1]===4)){const main=g.find(x=>x[1]===4)[0],rest=g.filter(x=>x[0]!==main);if(n===6&&rest.reduce((s,x)=>s+x[1],0)===2&&!(rest.some(x=>x[0]===16)&&rest.some(x=>x[0]===17)))return result('four-single',main);if(n===8&&rest.length===2&&rest.every(x=>x[1]===2))return result('four-pair',main);}
 for(const width of [3,...(max===3?[4]:[]),5]){if(n%width)continue;const k=n/width;if(k<2)continue;for(let start=3;start+k-1<=14;start++){const body=Array.from({length:k},(_,i)=>start+i);if(!body.every(r=>m.get(r)===3))continue;const rest=g.filter(x=>!body.includes(x[0]));if(width===3&&rest.length===0)return result('plane',start+k-1,k);if(width===4&&rest.every(x=>x[1]<=2)&&rest.reduce((s,x)=>s+x[1],0)===k&&!(m.has(16)&&m.has(17)))return result('plane-single',start+k-1,k);if(width===5&&rest.length===k&&rest.every(x=>x[1]===2))return result('plane-pair',start+k-1,k);}}
 return null;
}
export function beats(a,b){if(!a)return false;if(!b)return true;if(a.type==='rocket')return b.type!=='rocket';if(b.type==='rocket')return false;if(a.type==='bomb'){if(b.type!=='bomb')return true;return a.len>b.len||a.len===b.len&&a.high>b.high;}return b.type!=='bomb'&&a.type===b.type&&a.n===b.n&&a.high>b.high;}
