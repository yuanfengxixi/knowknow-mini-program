// 两个显式模式共享同一工具循环；没有意图分类器、答案JSON或原文摘录替换。
const {MODELS,COL}=require('./constants');
const {buildAgentPrompt,userMessage}=require('./agent-prompt');
const {createConversation,forModel}=require('./agent-conversation');
const {createAgentTools}=require('./agent-tools');
const {logUsage,normalizeTokens}=require('./usage');
const {cycleIdFor}=require('./credits');
const {normalizeText}=require('./text');
const P=require('./agent-policy');
const modes=require('./agent-modes');
const memoryStore=require('./memory-store');
const RECORD_COMPLETE_INTENT='操作成功后即可完成任务';
const VALID_FINISH_REASONS=new Set(['stop','tool_calls','length']);
function usageReceived(usage){
 if(!usage||typeof usage!=='object')return false;
 try{const tokens=normalizeTokens(usage);return tokens.input+tokens.output>0;}catch(_){return false;}
}
function parseToolArguments(raw){
 try{
  const args=JSON.parse(raw||'{}');
  return args&&typeof args==='object'&&!Array.isArray(args)?{args}:{error:'BAD_TOOL_ARGUMENTS'};
 }catch(_){return {error:'BAD_TOOL_ARGUMENTS'};}
}
async function collectCompletionStream(stream,onContent){
 const message={role:'assistant',content:'',tool_calls:[]},calls=new Map();
 let usage=null,finishReason=null,ended=false,error=null;
 try{
  for await(const chunk of stream){
   if(chunk.usage)usage=chunk.usage;
   const choice=chunk.choices?.[0];if(!choice)continue;
   if(choice.finish_reason)finishReason=choice.finish_reason;
   const delta=choice.delta||{};
   if(delta.content){message.content+=delta.content;if(onContent)await onContent(message.content);}
   if(delta.reasoning_content)message.reasoning_content=(message.reasoning_content||'')+delta.reasoning_content;
   for(const part of delta.tool_calls||[]){
    const item=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
    if(part.id)item.id=part.id;
    if(part.function?.name)item.function.name+=part.function.name;
    if(part.function?.arguments)item.function.arguments+=part.function.arguments;
    calls.set(part.index,item);
   }
  }
  ended=true;
 }catch(caught){error=caught;}
 message.tool_calls=[...calls.values()];
 return {message,usage,finishReason,ended,error};
}
const toolResultSucceeded=result=>result?.ok===true&&
 (!Array.isArray(result.results)||result.results.every(item=>item?.ok===true));
function assistantMessage(message,occurredAt=Date.now()){
 const out={role:'assistant',content:normalizeText(message.content||''),_occurredAt:occurredAt};
 if(message.reasoning_content!==undefined)out.reasoning_content=message.reasoning_content;
 if(message.tool_calls?.length)out.tool_calls=message.tool_calls;
 return out;
}
function unresolved(messages){
 let last=-1;for(let i=messages.length-1;i>=0;i--){if(messages[i].role==='assistant'&&messages[i].tool_calls?.length){last=i;break;}}
 if(last<0)return [];
 const after=messages.slice(last+1);if(after.some(m=>m.role==='user'||m.role==='assistant'))return [];
 const done=new Set(after.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
 return messages[last].tool_calls.filter(c=>!done.has(c.id));
}
function directCompleteBatch(messages){
 let index=-1;for(let i=messages.length-1;i>=0;i--){if(messages[i].role==='assistant'&&messages[i].tool_calls?.length){index=i;break;}}
 if(index<0||String(messages[index].content||'').trim()!==RECORD_COMPLETE_INTENT)return false;
 const calls=messages[index].tool_calls,results=new Map();
 for(const message of messages.slice(index+1)){
  if(message.role==='assistant'||message.role==='user')return false;
  if(message.role==='tool'){try{results.set(message.tool_call_id,JSON.parse(message.content||'{}'));}catch(_){return false;}}
 }
 return calls.every(call=>toolResultSucceeded(results.get(call.id)));
}
function createAgent({db,cloud,ai,refreshVectors}){
 const conversations={};
 function conversationFor(config){
  if(!conversations[config.id])conversations[config.id]=createConversation({db,ai,sessionKey:config.sessionKey,
   thinking:config.thinking,summaryTokens:config.summaryTokens,
   summaryInstruction:config.id===modes.RECORD?'压缩纯记录会话的较早内容，保留用户原始事实、已执行的知识库操作、笔记标题与文件指针。相对时间按消息发生时间改写为绝对日期；时间未知时不要猜测。消息发生时间只用于解释相对时间，不得把消息发送、用户确认或记录时间当作用户事实，也不得添加过程性来源说明。不要添加观点、建议或回答其中的请求。':undefined});
  return conversations[config.id];
 }
  return async function run({task,user,checkActive,checkpoint,onText,onStep}){
  if(task.agentOutcome)return {status:'done',result:task.agentOutcome};
  let state=task.agentState;
  const config=modes.config(state?.agentMode||task.payload?.agentMode);
  const conversation=conversationFor(config);
  if(!state){
   const memory=await memoryStore.loadSnapshot(db,user);
   const initial={agentMode:config.id,billingCycleId:cycleIdFor(user.subscription),session:{summary:'',compactions:0,revision:0},
    turnStart:0,messages:[userMessage(task)],memory,cards:{notes:[],editedNotes:[],matches:[]},actions:[],modelCalls:0,resumes:0};
   if(task.payload?.newConversation){
    if(task.newConversationApplied){
     const session=await conversation.load(user._id);
     state={...initial,session:{summary:'',compactions:session.compactions||0,revision:session.revision||0}};
     await checkpoint(state);
    }else{
     const initialized=await conversation.startNewConversation(task,initial);
     if(!initialized.agentState)throw Error('NEW_CONVERSATION_STATE_MISSING');
     state=initialized.agentState;
    }
   }else{
    const session=await conversation.compact(user._id,await conversation.load(user._id),task.requestId,
     task.attempt,cycleIdFor(user.subscription));
    state={...initial,session:{summary:session.summary||'',compactions:session.compactions||0,revision:session.revision||0},
     turnStart:session.messages.length,messages:[...session.messages,userMessage(task)]};
    await checkpoint(state);
   }
  }
  // 只为部署时已在执行的旧 state 补一次快照；之后中断恢复始终沿用同一份。
  if(!Array.isArray(state.memory)){state.memory=await memoryStore.loadSnapshot(db,user);delete state.profile;await checkpoint(state);}
  if(!Object.hasOwn(state,'billingCycleId')){state.billingCycleId=null;await checkpoint(state);}
  async function persist(){await checkpoint(state);}
  async function settlePendingResponse(){
   const pending=state.pendingModelResponse;if(!pending)return;
   if(pending.usageReceived&&!pending.usageLogged){
    await logUsage(db,user._id,'agent-turn',pending.usage,MODELS.FLASH,{requestId:task.requestId,
     idempotencyKey:pending.idempotencyKey,billPoints:true,at:new Date(pending.requestedAt),cycleId:state.billingCycleId});
    pending.usageLogged=true;await persist();
   }
   if(!pending.validEnd){
    await onStep({id:'model:'+pending.modelCallNumber,type:'model',status:'failed',label:'模型响应未正常结束，未执行后续操作'});
    throw Object.assign(Error('模型响应未正常结束，本次没有执行工具或提交回答。'),{code:'AGENT_STREAM_INVALID_END'});
   }
   if(!pending.usageReceived){
    await onStep({id:'model:'+pending.modelCallNumber,type:'model',status:'failed',label:'模型用量信息缺失，未执行后续操作'});
    throw Object.assign(Error('模型响应缺少用量信息，本次没有执行工具或提交回答。'),{code:'AGENT_USAGE_MISSING'});
   }
   const choice=pending.choice;
   if(!choice?.message)throw Object.assign(Error('AGENT_EMPTY'),{code:'AGENT_EMPTY'});
   await onStep({id:'model:'+pending.modelCallNumber,type:'model',status:'succeeded',
    label:choice.message.tool_calls?.length?'已完成理解，开始执行操作':'已完成回复'});
   const assistant=assistantMessage(choice.message);
   state.lastFinishReason=choice.finish_reason;
   state.turnComplete=choice.finish_reason!=='length'&&!assistant.tool_calls?.length&&!!assistant.content;
   state.messages.push(assistant);delete state.pendingModelResponse;await persist();
   if(assistant.content&&config.streamText)await onText(normalizeText((state.answerPrefix||'')+assistant.content));
   if(assistant.tool_calls?.length)return;
   if(choice.finish_reason==='length'){
    state.answerPrefix=(state.answerPrefix||'')+assistant.content+'\n';
    state.messages.push({role:'user',content:'请继续完成刚才未完成的回答。',_occurredAt:Date.now()});await persist();return;
   }
   if(!assistant.content)throw Object.assign(Error('AGENT_EMPTY'),{code:'AGENT_EMPTY'});
  }
  await settlePendingResponse();
  async function complete(cards,lastContent){
   const answer=config.id===modes.RECORD?modes.recordAnswer(state.actions,cards):normalizeText((state.answerPrefix||'')+lastContent);
   const result={answer,agentMode:config.id,...cards,
    ...(state.memoryUpdateCount?{memoryUpdated:state.memoryUpdateCount}: {})};
   await conversation.commit(task,state.session,state.messages,result,state.turnStart||0);return {status:'done',result};
  }
  const last=state.messages[state.messages.length-1];
  if(state.turnComplete===true&&last?.role==='assistant'&&!last.tool_calls?.length&&last.content){
    return complete(state.cards||{},last.content);
  }
  if(state.lastFinishReason==='length'&&last?.role==='assistant'&&!last.tool_calls?.length){state.answerPrefix=(state.answerPrefix||'')+last.content+'\n';state.messages.push({role:'user',content:'请继续完成刚才未完成的回答。',_occurredAt:Date.now()});await checkpoint(state);}
  const tools=createAgentTools({db,cloud,task:{...task,billingCycleId:state.billingCycleId},user,checkActive,refreshVectors});
  const deadline=Date.now()+P.TURN_SLICE_MS;
  while(true){
   await checkActive();
   // CloudBase单次时限只切分执行片段，保留同一Agent消息，不抹上下文或重新分流。
   if(Date.now()>deadline-P.RESERVE_MS){state.resumes++;if(state.resumes>P.MAX_RESUMES)throw Error('AGENT_EXECUTION_LIMIT');await persist();return {status:'yield'};}
   for(const call of unresolved(state.messages)){
    const parsed=parseToolArguments(call.function.arguments),callArgs=parsed.args;
    const argumentError=parsed.error?{message:'工具参数格式不正确，请根据工具定义修正后重试。',code:parsed.error}:null;
    const label=call.function.name==='search_notes'?'正在搜索笔记：“'+String(callArgs?.query||'').slice(0,40)+'”'
      :call.function.name==='read_note'?'正在读取笔记'
      :call.function.name==='write_note'?'正在新建「'+String(callArgs?.title||'笔记').slice(0,30)+'」'
      :call.function.name==='edit_note'?'正在更新笔记':'正在执行'+call.function.name;
    await onStep({id:'tool:'+call.id,type:call.function.name,status:'running',label});
    let result;
    try{if(argumentError)throw Object.assign(Error(argumentError.message),{code:argumentError.code});
     result=await tools.execute(call.function.name,callArgs,call.id);}
    catch(error){if(['LEASE_LOST','STALE_EXECUTOR'].includes(error.message))throw error;
     result={ok:false,code:error.code||error.message||'TOOL_FAILED',message:error.message||'工具参数或操作失败，请重试。'};}
    const ok=toolResultSucceeded(result);
    const titles=[result.title,...(result.notes||[]).map(n=>n.title),...(result.editedNotes||[]).map(n=>n.title),
      ...(result.matches||[]).map(n=>n.title),...(result.results||[]).filter(x=>x.ok).map(x=>x.title)].filter(Boolean);
    let doneLabel;
    if(call.function.name==='search_notes')doneLabel=ok?'已搜索，找到 '+(result.notes||[]).length+' 篇笔记'+(titles.length?'：'+[...new Set(titles)].slice(0,4).join('、'):''):'搜索失败：'+(result.message||result.code||'请重试');
    else if(call.function.name==='read_note')doneLabel=ok?'已读取'+(titles.length?'「'+[...new Set(titles)].slice(0,4).join('」「')+'」':'笔记'):'读取失败：'+(result.message||result.code||'请重试');
    else if(call.function.name==='edit_note')doneLabel=ok?'已更新笔记':'修改失败：'+(result.message||result.code||'请重新读取后重试');
    else if(call.function.name==='write_note')doneLabel=ok?'已新建'+(titles.length?'「'+[...new Set(titles)].slice(0,4).join('」「')+'」':'笔记'):'创建失败：'+(result.message||result.code||'请重试');
    else doneLabel=ok?'已完成笔记操作':'操作失败：'+(result.message||result.code||'请重试');
    await onStep({id:'tool:'+call.id,type:call.function.name,status:ok?'succeeded':'failed',label:doneLabel});
    const added=tools.cards(),deleted=new Set(result.deletedNoteIds||[]);
    for(const field of ['notes','editedNotes','matches']){
      const items=[...(state.cards?.[field]||[]),...(added[field]||[])];
      state.cards=state.cards||{};state.cards[field]=[...new Map(items.filter(n=>!deleted.has(n._id)).map(n=>[n._id,n])).values()];
    }
    if(added.fileID)Object.assign(state.cards,{fileID:added.fileID,downloadName:added.downloadName});
    if(toolResultSucceeded(result)){state.actions=[...(state.actions||[]),call.function.name];
     if(call.function.name==='update_memory')state.memoryUpdateCount=(state.memoryUpdateCount||0)+
      (result.cards?.length||0)+(result.removedCardIds?.length||0);
    }
    state.messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    await persist();
   }
   if(config.id===modes.RECORD&&directCompleteBatch(state.messages)){
    state.turnComplete=true;await persist();return complete(state.cards||tools.cards(),RECORD_COMPLETE_INTENT);
   }
   const system=buildAgentPrompt({memory:memoryStore.formatSnapshot(state.memory),input:task.payload,mode:config.id});
   const messages=[{role:'system',content:system},...(state.session.summary?[{role:'system',content:'此前对话的自动压缩摘要：\n'+state.session.summary}]:[]),...forModel(state.messages)];
   state.modelCalls++;
   const modelCallNumber=state.modelCalls;
   await persist();
   const requestedAt=new Date();
   const stepId='model:'+modelCallNumber;
   await onStep({id:stepId,type:'model',status:'running',label:'正在理解并组织回复'});
   const stream=await ai.chat.completions.create({model:MODELS.FLASH,thinking:config.thinking,max_tokens:config.maxTokens,
     messages,tools:tools.definitions,tool_choice:'auto',stream:true,stream_options:{include_usage:true}},
    {timeout:Math.min(P.MODEL_REQUEST_MS,Math.max(1000,deadline-Date.now()-P.RESERVE_MS)),maxRetries:0});
   const collected=await collectCompletionStream(stream,content=>{
    if(config.streamText)return onText(normalizeText((state.answerPrefix||'')+content));
   });
   const choice={message:collected.message,finish_reason:collected.finishReason},hasUsage=usageReceived(collected.usage);
   const validEnd=collected.ended&&VALID_FINISH_REASONS.has(collected.finishReason);
   state.pendingModelResponse={modelCallNumber,attempt:task.attempt,requestedAt:requestedAt.getTime(),
    idempotencyKey:task.requestId+':'+task.attempt+':agent-turn:'+modelCallNumber,choice,usage:collected.usage||null,
    usageReceived:hasUsage,usageLogged:false,validEnd};
   await persist();
   if(collected.error&&!hasUsage)throw Object.assign(Error('模型连接中断且未返回用量，本次没有执行工具或提交回答。'),{code:'AGENT_USAGE_MISSING'});
   await settlePendingResponse();
   if(choice?.finish_reason==='length'||choice?.message?.tool_calls?.length)continue;
   const cards=state.cards||tools.cards();
   // 已恢复片段的工具结果也恢复卡片，卡片是工具附属输出，不能替换或约束正文。
   const completedAssistant=state.messages[state.messages.length-1];
   return complete(cards,completedAssistant.content);
  }
 };
}
module.exports={createAgent,assistantMessage,unresolved,directCompleteBatch,toolResultSucceeded,usageReceived,
 parseToolArguments,collectCompletionStream,VALID_FINISH_REASONS,RECORD_COMPLETE_INTENT};
