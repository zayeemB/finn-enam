import {GroqClient} from '../analysis/groq.js';

// The demo Groq key has a much smaller token allowance than Gemini.
// Preserve complete, numbered passages while reducing the fallback's context.
export class GroqBrief extends GroqClient {
  async generate(request){
    const input=JSON.parse(request.prompt);
    const words=new Set((input.question.toLowerCase().match(/[a-z]{4,}/g)||[]).concat(
      /cash|debt|profit/i.test(input.question)?['cash','operating','activities','debt','working','capital']:[]));
    const ranked=input.evidence.flatMap(page=>page.passages.map(p=>{
      const text=p.text.toLowerCase();
      let score=[...words].reduce((sum,word)=>sum+(text.includes(word)?1:0),0);
      if(/net cash.*operating|cash generated from operations/i.test(text.replace(/\s+/g,' ')))score+=20;
      return {...p,page,score};
    })).sort((a,b)=>b.score-a.score);
    const passages=[],seen=new Set();
    const take=p=>{if(p&&!seen.has(p.id)&&passages.length<12){passages.push(p);seen.add(p.id);}};
    for(const title of new Set(input.evidence.map(p=>p.title)))take(ranked.find(p=>p.page.title===title));
    for(const p of ranked)take(p);
    const evidence=input.evidence.map(page=>({...page,passages:page.passages.filter(p=>seen.has(p.id))})).filter(p=>p.passages.length);
    const response=await super.generate({...request,images:[],
      prompt:JSON.stringify({...input,evidence,image_source_ids:[]}),
      systemInstruction:request.systemInstruction+' Write a short brief with at most 3 topics and 4 total findings. Keep it under 230 words. Use text passage citations only.'});
    return {...response,sourceIds:[...seen]};
  }
}
