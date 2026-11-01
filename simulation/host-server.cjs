#!/usr/bin/env node
// Runs the shared C++ application on the PC. HTTP is only its test I/O adapter.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createSimulationController}=require('./host-controller.cjs');

const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
function argument(args,name,fallback) {
  const index=args.indexOf(name);if(index<0)return fallback;
  if(index===args.length-1 || args[index+1].startsWith('--'))throw Error(`Missing ${name}`);
  return args[index+1];
}
async function loadApplication(runtimeRoot) {
  const {default:createApp}=await import(pathToFileURL(path.join(runtimeRoot,'lvgl-ui.mjs')).href);
  const wasmBinary=await fs.readFile(path.join(runtimeRoot,'lvgl-ui.wasm'));
  return createApp({wasmBinary});
}
async function createHostServer(options={}) {
  const root=options.root??__dirname;
  const panelRoot=path.resolve(options.panelRoot??root);
  const componentsRoot=path.resolve(options.componentsRoot??path.join(root,'gar-components'));
  const app=options.module??await loadApplication(options.runtimeRoot??path.join(root,'runtime'));
  const controller=createSimulationController(app);
  const buildId=options.buildId??process.env.GAR_BUILD_ID??'development';
  const instanceId=options.instanceId??'development';
  if(typeof buildId!=='string'||!buildId||typeof instanceId!=='string'||!instanceId)throw Error('Invalid runtime identity');
  const host=options.host??'127.0.0.1';
  if(host!=='127.0.0.1')throw Error('Simulator must bind to 127.0.0.1');
  const requestedPort=options.port??8772;
  if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw Error('Invalid port');
  let closed=false,port=0;
  const started=Date.now();
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; frame-ancestors 'none'"};
  function respond(res,status,type,value) {res.writeHead(status,{...headers,'Content-Type':type});res.end(value);}
  const json=(res,status,value)=>respond(res,status,'application/json; charset=utf-8',JSON.stringify(value));
  const originAllowed=req=>!req.headers.origin || req.headers.origin===`http://127.0.0.1:${port}` || req.headers.origin===`http://localhost:${port}`;
  async function body(req) {
    if(req.headers['content-type']?.split(';')[0]!=='application/json')throw Error('JSON required');
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>150000)throw Error('Body too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return json(res,403,{ok:false,error:'Loopback host required'});
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.method==='GET'&&url.pathname==='/health') {
        const state=controller.snapshot();
        return json(res,200,{ok:true,buildId,runningBuildId:buildId,instanceId,pid:process.pid,
          runtime:'shared-cpp-wasm-node',mode:state.mode,uptimeMs:Date.now()-started,frame:state.frame,
          width:state.width,height:state.height,metrics:state.metrics,syntheticRepliesOnly:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,controller.snapshot());
      if(req.method==='GET'&&url.pathname==='/api/frame')return respond(res,200,'application/octet-stream',controller.frame());
      if(req.method==='POST'&&url.pathname==='/api/control') {
        if(!originAllowed(req))return json(res,403,{ok:false,error:'Same-origin controls only'});
        const command=await body(req);controller.control(command);return json(res,200,{ok:true,...controller.snapshot()});
      }
      if(req.method!=='GET')return json(res,404,{ok:false});
      let filename;
      const panelFiles=new Map([['/','index.html'],['/index.html','index.html'],['/adapter.mjs','adapter.mjs'],['/style.css','style.css']]);
      if(panelFiles.has(url.pathname))filename=path.join(panelRoot,panelFiles.get(url.pathname));
      else if(/^\/gar-components\/[a-z0-9-]+\.(mjs|js|css)$/.test(url.pathname)) {
        filename=path.join(componentsRoot,path.basename(url.pathname));
        // A deployed public component must not resolve outside the component directory.
        const relative=path.relative(await fs.realpath(componentsRoot),await fs.realpath(filename));
        if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))return json(res,404,{ok:false});
      } else return json(res,404,{ok:false});
      return respond(res,200,mime[path.extname(filename)],await fs.readFile(filename));
    } catch(error) {
      if(res.headersSent){res.destroy();return;}
      json(res,error.code==='ENOENT'?404:400,{ok:false,error:error.code==='ENOENT'?'Not found':'Invalid request'});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,host,resolve);});
  port=server.address().port;
  let last=performance.now();
  const timer=options.manualClock?undefined:setInterval(()=>{
    const current=performance.now(),delta=Math.floor(current-last);
    if(delta>0){last+=delta;controller.tick(Math.min(delta,60000));}
  },10);
  return {port,controller,
    close:async()=>{if(closed)return;closed=true;clearInterval(timer);server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
async function main() {
  const args=process.argv.slice(2),root=path.resolve(argument(args,'--root',__dirname));
  const bundled=path.join(root,'gar-components');
  const componentsRoot=argument(args,'--components',await fs.access(bundled).then(()=>bundled,()=>path.join(root,'../sources/gar-tools/web-simulator/components')));
  const running=await createHostServer({root,componentsRoot,
    host:argument(args,'--host','127.0.0.1'),port:Number(argument(args,'--port','8772')),
    buildId:argument(args,'--build-id',process.env.GAR_BUILD_ID??'development'),
    instanceId:argument(args,'--instance-id','development')});
  console.log(JSON.stringify({event:'simulator-started',url:`http://127.0.0.1:${running.port}/`,pid:process.pid}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>running.close().then(()=>process.exit(0)));
}
if(require.main===module)main().catch(error=>{console.error(`Simulator could not start: ${error.message}`);process.exitCode=1;});
module.exports={createHostServer,loadApplication};
