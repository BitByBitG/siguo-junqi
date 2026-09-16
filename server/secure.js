import crypto from 'node:crypto';

export function installSecure(app, io, authenticated) {
  const channels = new Map();
  const limits = new Map(), failures=new Map();
  const seal = (channel, value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', channel.key, iv);
    cipher.setAAD(Buffer.from('server-v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify({value,time:Date.now(),nonce:crypto.randomUUID()})), cipher.final(), cipher.getAuthTag()]);
    return {iv:iv.toString('base64'), data:data.toString('base64')};
  };
  const open = (channel, packet) => {
    const iv = Buffer.from(packet.iv, 'base64'), data = Buffer.from(packet.data,'base64');
    if(iv.length!==12 || data.length<16)throw Error('密文格式错误');
    const decipher=crypto.createDecipheriv('aes-256-gcm',channel.key,iv);
    decipher.setAAD(Buffer.from('client-v1'));decipher.setAuthTag(data.subarray(-16));
    const value=JSON.parse(Buffer.concat([decipher.update(data.subarray(0,-16)),decipher.final()]).toString());
    if(typeof value.nonce!=='string'||Math.abs(Date.now()-value.time)>120000||channel.seen.has(value.nonce))throw Error('请求过期或重复');
    for(const [nonce,time]of channel.seen)if(Date.now()-time>120000)channel.seen.delete(nonce);
    channel.seen.set(value.nonce,Date.now());return value;
  };
  app.post('/api/crypto', (req,res)=>{
    try {
      const ip=req.socket.remoteAddress, now=Date.now();
      const limit=limits.get(ip)||{time:now,n:0};if(now-limit.time>60000){limit.time=now;limit.n=0;}limits.set(ip,limit);
      if(++limit.n>60||channels.size>=5000)return res.status(429).json({error:'连接过于频繁'});
      const pub=crypto.createPublicKey({key:req.body.publicKey,format:'jwk'});
      if(pub.asymmetricKeyType!=='rsa'||pub.asymmetricKeyDetails.modulusLength<2048||pub.asymmetricKeyDetails.modulusLength>4096)throw Error();
      const key=crypto.randomBytes(32),id=crypto.randomUUID();
      const wrapped=crypto.publicEncrypt({key:pub,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
      channels.set(id,{key,seen:new Map(),expires:now+86400000});
      res.set('Cache-Control','no-store').json({id,key:wrapped.toString('base64')});
    }catch{res.status(400).json({error:'无法建立加密连接'});}
  });
  app.use((req,res,next)=>{
    if(req.path==='/api/secure'){
      try{
        const channel=channels.get(req.body.id);if(!channel||channel.expires<Date.now())throw Error();
        const value=open(channel,req.body);
        if(value.kind!=='http'||!/^\/api\/(?!secure|crypto)/.test(value.url))throw Error();
        if(!['GET','POST','PUT','DELETE','PATCH'].includes(value.method))throw Error();
        req.url=value.url;req.method=value.method;req.body=value.body;
        req.query=Object.fromEntries(new URL(value.url,'http://localhost').searchParams);
        req.headers.authorization=value.authorization||'';req.headers['x-admin-key']=value.adminKey||'';
        req.secureChannel=channel;
        const login=['/api/login','/api/bot/login'].includes(req.path),admin=req.path.startsWith('/api/admin/');
        const attemptKey=login?`login:${String(req.body?.username||'').trim()}`:admin?`admin:${req.socket.remoteAddress}`:null;
        let failure=attemptKey&&failures.get(attemptKey);
        if(failure&&Date.now()-failure.time>60000){failures.delete(attemptKey);failure=null;}
        const json=res.json.bind(res);res.json=data=>{
          if(attemptKey&&[401,403].includes(res.statusCode)){const f=failures.get(attemptKey)||{time:Date.now(),n:0};f.n++;failures.set(attemptKey,f);}
          res.set('Cache-Control','no-store');return json(seal(channel,data));
        };
        if(failure?.n>=20)return res.status(429).json({error:'验证失败次数过多，请一分钟后重试'});
        next();
      }catch{res.status(400).json({error:'加密连接失效，请刷新页面'});}
      return;
    }
    // Hosted BOT traffic stays on loopback. External BOT clients must use the encrypted API.
    if(req.path.startsWith('/api/')&&!(req.path.startsWith('/api/bot/')&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&!req.headers['cf-ray']&&!req.headers['x-forwarded-for']))
      return res.status(426).json({error:'请使用加密客户端'});
    next();
  });
  io.use((socket,next)=>{
    try{
      const channel=channels.get(socket.handshake.auth.id);
      if(!channel||channel.expires<Date.now()||open(channel,socket.handshake.auth.proof).kind!=='socket')throw Error();
      socket.data.channel=channel;next();
    }catch{next(Error('需要加密连接'));}
  });
  io.on('connection',socket=>{
    const channel=socket.data.channel,native=socket.emit.bind(socket);
    socket.emit=(event,...args)=>{
      if(['room-state','chat-mention','lobby-chat','moderation-state','account-profile'].includes(event)&&!authenticated(socket))return socket;
      native('sealed',seal(channel,{event,args}));return socket;
    };
    socket.use((packet,next)=>{
      try{
        if(packet[0]!=='sealed'||channel.expires<Date.now())throw Error();
        const value=open(channel,packet[1]);
        if(value.kind!=='event'||typeof value.event!=='string'||!Array.isArray(value.args)||value.event==='disconnect')throw Error();
        const permitted=['lobby-auth','create-room','join-room','watch-room'];
        if(!permitted.includes(value.event)&&!authenticated(socket))throw Error();
        const ack=typeof packet.at(-1)==='function'?packet.at(-1):null;
        packet.splice(0,packet.length,value.event,...value.args);
        if(ack)packet.push((...args)=>ack(seal(channel,{args})));
        next();
      }catch{socket.emit('game-error','登录或加密连接已失效');}
    });
  });
  const timer=setInterval(()=>{
    for(const[id,c]of channels)if(c.expires<Date.now())channels.delete(id);
    for(const[ip,l]of limits)if(Date.now()-l.time>60000)limits.delete(ip);
    for(const[key,f]of failures)if(Date.now()-f.time>60000)failures.delete(key);
    for(const socket of io.sockets.sockets.values())if(socket.data.authToken&&!authenticated(socket))socket.disconnect(true);
  },30000);timer.unref();
}
