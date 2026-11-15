// 业务写入后的索引同步；向量失败不丢原笔记，后续仍可文本召回。
const OpenAI=require('openai');
const {COL}=require('./_shared/constants');
const {key}=require('./_shared/task-queue-io');
const {logUsage}=require('./_shared/usage');
function createVectorRefresh(db){
 const model=process.env.EMBEDDING_MODEL||'BAAI/bge-m3';
 const client=process.env.EMBEDDING_API_KEY?new OpenAI({apiKey:process.env.EMBEDDING_API_KEY,
  baseURL:process.env.EMBEDDING_BASE_URL||'https://api.siliconflow.cn/v1',timeout:10000,maxRetries:0}):null;
 return async(userId,noteIds)=>{
  if(!client||!noteIds.length)return;
  const notes=(await db.collection(COL.NOTES).where({userId,_id:db.command.in(noteIds),deletedAt:null}).get()).data;
  if(!notes.length)return;
  const response=await client.embeddings.create({model,input:notes.map(n=>`${n.title}\n${n.content}`.slice(0,2000))});
  await logUsage(db,userId,'task-index',{input:response.usage?.total_tokens||0,output:0},model);
  for(let i=0;i<notes.length;i++){
   // 更新统一确定性向量；旧版同noteId存量向量由删除态笔记过滤避免成为证据。
   const existing=(await db.collection(COL.NOTE_VECTORS).where({userId,noteId:notes[i]._id}).limit(1).get()).data[0];
   await db.collection(COL.NOTE_VECTORS).doc(existing?existing._id:key(userId,notes[i]._id)).set({data:{userId,noteId:notes[i]._id,
    vector:response.data[i].embedding,model,updatedAt:db.serverDate()}});
  }
 };
}
module.exports={createVectorRefresh};
