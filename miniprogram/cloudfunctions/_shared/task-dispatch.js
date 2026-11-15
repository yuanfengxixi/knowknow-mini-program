// SCF Event 投递只等待云端接收；不依赖客户端连接或未await的后台Promise。
const crypto=require('crypto');
const {LIMITS}=require('./task-protocol');
const sign=(secret,body)=>crypto.createHmac('sha256',secret).update(JSON.stringify(body)).digest('hex');
function envelope(userId){
 const secret=process.env.TASK_DISPATCH_SECRET;if(!secret)throw Error('DISPATCH_NOT_CONFIGURED');
 const body={userId,time:Date.now(),nonce:crypto.randomBytes(12).toString('hex')};
 return {...body,signature:sign(secret,body)};
}
function verify(event){
 const secret=process.env.TASK_DISPATCH_SECRET;
 if(!secret||!event||typeof event.signature!=='string'||Math.abs(Date.now()-event.time)>LIMITS.WORKER_LEASE_MS)return false;
 const expected=sign(secret,{userId:event.userId,time:event.time,nonce:event.nonce});
 return event.signature.length===expected.length&&crypto.timingSafeEqual(Buffer.from(event.signature),Buffer.from(expected));
}
async function dispatch(userId){
 const {Client}=require('tencentcloud-sdk-nodejs-scf').scf.v20180416;
 // 云函数短期凭据优先，不将用户长期腾讯密钥打进部署包。
 const client=new Client({credential:{secretId:process.env.TENCENTCLOUD_SECRETID,
  secretKey:process.env.TENCENTCLOUD_SECRETKEY,token:process.env.TENCENTCLOUD_SESSIONTOKEN},
  region:process.env.TENCENTCLOUD_REGION||'ap-shanghai',profile:{httpProfile:{reqTimeout:5}}});
 return client.Invoke({FunctionName:process.env.TASK_WORKER_NAME||'task-worker',
  Namespace:process.env.TCB_ENV||process.env.SCF_NAMESPACE,InvocationType:'Event',
  ClientContext:JSON.stringify(envelope(userId))});
}
module.exports={dispatch,verify,envelope};
