import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {marked} from 'marked';
const root=new URL('../',import.meta.url),destination=new URL('public/locales/en/',root);
await mkdir(destination,{recursive:true});
for(const [source,target]of [['RULES.en.md','rules.html'],['BOT_API.en.md','bot-api.html']]){
  const sourcePath=new URL(source,root),markdown=await readFile(sourcePath,'utf8');
  const download=source==='BOT_API.en.md'?'<p><a class="document-download" href="/BOT_API.en.md" download="BOT_API.en.md">Download BOT_API.md</a></p>':'';
  await writeFile(new URL(target,destination),download+marked.parse(markdown));
  await copyFile(sourcePath,new URL('public/'+source,root));
}
