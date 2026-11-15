const cloud=require('wx-server-sdk');
const OpenAI=require('openai');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const {DEEPSEEK_BASE_URL}=require('./_shared/constants');
const {dispatch,verify}=require('./_shared/task-dispatch');
exports.main=async(event={},context={})=>{
 try{
  const {OPENID}=cloud.getWXContext();
  // 普通小程序用户不能伪造worker参数或定时事件；入队只能走鉴权的task-service。
  const signed=verify(event);
  // 云端异步调用可能继承发起用户上下文；有效服务签名才允许执行，不能仅因有OPENID拒绝。
  if(!signed){
    if(!OPENID&&event.Type==='Timer'&&event.TriggerName==='taskQueueRecovery')return require('./sweep').sweep({db,dispatch});
    return {ok:false,code:'UNAUTHORIZED'};
  }
  const ai=new OpenAI({apiKey:process.env.DEEPSEEK_API_KEY,baseURL:DEEPSEEK_BASE_URL,timeout:20000,maxRetries:0});
  const worker=require('./worker').createWorker({db,cloud,ai,dispatch,refreshVectors:require('./vectors').createVectorRefresh(db)});
  return await worker.run(event.userId);
 }catch(error){console.error('task-worker failed',error.code||error.name);return {ok:false,code:'WORKER_FAILED'};}
};
