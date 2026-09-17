import {colorRating} from './rating-colors.js';
import {renderRichChatBody} from './chat-common.js';
import "/secure.js";
const rankingBody = document.querySelector("#ranking-body");
const signatureHeading=document.createElement('th');signatureHeading.textContent='个性签名';document.querySelector('.ranking-table thead tr').children[2].before(signatureHeading);

function textCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}
function signatureCell(value) {
  const cell=document.createElement('td');cell.className='signature-snippet chat-content';cell.title=value||'';
  renderRichChatBody(cell,value||'');return cell;
}

const botRanking=new URLSearchParams(location.search).get('type')==='bot';
if(botRanking)document.querySelector('h1').textContent='BOT Rating 排名';
const tabs=document.createElement('nav');tabs.className='profile-tabs';tabs.innerHTML='<a href="/ratings.html">人类排名</a><a href="/ratings.html?type=bot">BOT 排名</a>';document.querySelector('.ranking-header').append(tabs);
fetch("/api/ratings"+(botRanking?'?type=bot':''))
  .then(async (response) => {
    if (!response.ok) throw new Error("排名加载失败");
    return response.json();
  })
  .then((accounts) => {
    rankingBody.replaceChildren();
    if (!accounts.length) {
      const row = document.createElement("tr");
      const cell = textCell("暂无账号", "ranking-empty");
      cell.colSpan = 7;
      row.append(cell);
      rankingBody.append(row);
      return;
    }
    for (const account of accounts) {
      const row = document.createElement("tr");
      row.append(
        textCell(account.position, "ranking-position"),
        colorRating(textCell(account.username, "ranking-name"), account.rating),
        signatureCell(account.signature),
        colorRating(textCell(account.rank, "rank-badge"), account.rating),
        colorRating(textCell(account.rating, "ranking-rating"), account.rating),
        textCell(account.ratedGames),
        colorRating(textCell(account.peakRating), account.peakRating),
      );
      const name=row.children[1],a=document.createElement('a');a.textContent=account.username;a.href='/profile/'+encodeURIComponent(account.username);colorRating(a,account.rating);name.replaceChildren(a);
      rankingBody.append(row);
    }
  })
  .catch((error) => {
    rankingBody.replaceChildren();
    const row = document.createElement("tr");
    const cell = textCell(error.message, "ranking-empty");
    cell.colSpan = 7;
    row.append(cell);
    rankingBody.append(row);
  });
