import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createFacePreparationServer} from '../face-preparation-lab/server.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
export class BackendClient {
  constructor({waiRoot,outputRoot,python='python'}){
    this.pending=new Map();this.serial=0;this.failure=null;
    this.child=spawn(python,['-u',path.join(directory,'backend.py'),'--wai-root',waiRoot,'--output-root',outputRoot],
      {cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
    const fail=message=>{this.failure=message;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(message));}this.pending.clear();};
    this.child.on('error',e=>fail(e.message));
    this.child.on('exit',code=>fail('活动适配进程已退出：'+code));
    this.child.stderr.on('data',chunk=>process.stderr.write(chunk));
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{const message=JSON.parse(line),p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);message.ok?p.resolve(message.result):p.reject(Error(message.error));}
      catch(e){fail('活动适配协议错误：'+e.message);}
    });
  }
  call(data){return new Promise((resolve,reject)=>{
    if(this.failure)return reject(Error(this.failure));
    const id=++this.serial,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('活动状态请求超时'));},5000);
    this.pending.set(id,{resolve,reject,timer});
    this.child.stdin.write(JSON.stringify({...data,id})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  });}
  close(){this.child.stdin.end();}
}
export async function createIdleActivityServer({waiRoot=path.resolve(root,'../../WAI'),
  outputRoot=path.join(root,'outputs/idle-activity-demo-20261024'),python='python',backend=null}={}){
  await mkdir(outputRoot,{recursive:true});
  backend??=new BackendClient({waiRoot,outputRoot,python});
  const server=createFacePreparationServer(),previous=server.listeners('request')[0];
  server.removeAllListeners('request');
  const pages=new Map([['','index.html'],['index.html','index.html'],['viewer.mjs','viewer.mjs'],
    ['motion.mjs','motion.mjs'],['scheduler.mjs','scheduler.mjs'],['voice-gate.mjs','voice-gate.mjs'],['style.css','style.css']]);
  server.on('close',()=>backend.close());
  server.on('request',async(req,res)=>{
    let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);return res.end();}
    if(!url.pathname.startsWith('/idle-activity-demo/'))return previous(req,res);
    const port=server.address()?.port,hosts=['127.0.0.1:'+port,'localhost:'+port];
    const send=(code,data,type='application/json; charset=utf-8')=>{
      const bytes=Buffer.isBuffer(data)?data:Buffer.from(type.startsWith('application/json')?JSON.stringify(data):data);
      res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':bytes.length});
      res.end(req.method==='HEAD'?undefined:bytes);
    };
    if(!hosts.includes(req.headers.host))return send(403,{error:'Host denied'});
    const route=url.pathname.slice('/idle-activity-demo/'.length);
    try{
      if(route==='state'&&req.method==='GET')return send(200,await backend.call({action:'snapshot'}));
      if(route==='command'&&req.method==='POST'){
        const origin=req.headers.origin;
        if(!hosts.map(h=>'http://'+h).includes(origin)||req.headers['content-type']!=='application/json')return send(403,{error:'Origin/content type denied'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>4096)return send(413,{error:'Too large'});chunks.push(chunk);}
        const data=JSON.parse(Buffer.concat(chunks).toString());
        if(!['start','pause','resume','speech-start','speech-end','conversation-end','cancel'].includes(data.action))return send(400,{error:'Unknown action'});
        return send(200,await backend.call(data));
      }
      if(!['GET','HEAD'].includes(req.method))return send(405,{error:'Method denied'});
      const file=pages.get(route);if(!file)return send(404,{error:'Unknown route'});
      const mime=file.endsWith('.mjs')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
      return send(200,await readFile(path.join(directory,file)),mime);
    }catch(error){send(409,{error:error.message});}
  });
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
  const port=Number(arg('--port','18798'));
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  const server=await createIdleActivityServer({waiRoot:arg('--wai-root',path.resolve(root,'../../WAI')),python:arg('--python','python')});
  server.on('error',e=>{console.error(e);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log('Independent idle activity demo: http://127.0.0.1:'+port+'/idle-activity-demo/'));
}
