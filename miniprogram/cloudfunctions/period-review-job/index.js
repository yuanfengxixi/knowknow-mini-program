// 自动报告也是同一个Agent的一条后台请求，不再维护月报/年报专属回复提示词。
const cloud=require('wx-server-sdk');cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database(),{COL}=require('./_shared/constants');
const {createQueue}=require('./_shared/task-queue'),{dispatch}=require('./_shared/task-dispatch');
exports.main=async(event={})=>{
 try{
  if(cloud.getWXContext().OPENID)return {ok:false,code:'UNAUTHORIZED'};
  const period=event.TriggerName==='yearlyReview'?'year':'month';
  const today=new Date(Date.now()+8*3600000),year=today.getUTCFullYear(),month=today.getUTCMonth();
  const end=new Date(Date.UTC(year,period==='year'?0:month,1)-1),start=period==='year'?`${year-1}-01-01`:new Date(Date.UTC(year,month-1,1)).toISOString().slice(0,10);
  const queue=createQueue(db);let last=null,count=0;
  do{
   let q=db.collection(COL.USERS).where({'subscription.status':db.command.in(['monthly','yearly']),'subscription.endAt':db.command.gt(new Date())});
   if(last)q=q.where({_id:db.command.gt(last)});
   const page=await q.orderBy('_id','asc').limit(100).get();
   for(const user of page.data){const r=await queue.submit(user._id,{requestId:`scheduled_${period}_${start}_${user._id}`,rawText:`请根据${start}至${end.toISOString().slice(0,10)}的笔记做一份${period==='year'?'年度':'月度'}复盘，保存到知识库。`,inputType:'text'});if(r.created){await dispatch(user._id);count++;}}
   last=page.data.length===100?page.data[page.data.length-1]._id:null;
  }while(last);
  return {ok:true,queued:count};
 }catch(error){console.error('scheduled agent failed',error.code||error.name);return {ok:false,code:'SERVER_ERROR'};}
};
