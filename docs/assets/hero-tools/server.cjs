const http=require('http'),fs=require('fs'),path=require('path');const dir=__dirname;fs.mkdirSync(path.join(dir,'frames'),{recursive:true});
const types={'.mp4':'video/mp4','.html':'text/html','.webp':'image/webp','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
http.createServer((q,s)=>{const u=decodeURIComponent(q.url.split('?')[0]);
if(q.method==='POST'){const chunks=[];q.on('data',c=>chunks.push(c));q.on('end',()=>{fs.writeFileSync(path.join(dir,u.startsWith('/frame/')?'frames':'.',path.basename(u)),Buffer.concat(chunks));s.end('ok')});return}
const f=path.join(dir,u.startsWith('/frames/')?'frames':'.',path.basename(u)||'x');fs.readFile(f,(e,b)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream','cache-control':'no-store'});s.end(b)})}).listen(4176,'127.0.0.1');
