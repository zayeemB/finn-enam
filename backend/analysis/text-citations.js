import {normalise} from './validation.js';
import {RESPONSE_SCHEMA} from './schema.js';

function citationBranch(block,modality,quotes){
  return {type:'object',properties:{block_id:block===null?{type:'null'}:{type:'string',enum:[block]},
    modality:{type:'string',enum:[modality]},quote:{type:'string',...(quotes?{enum:quotes}:{})}},
    required:['block_id','modality','quote'],additionalProperties:false};
}
function schemaWithCitations(branches){
  const schema=structuredClone(RESPONSE_SCHEMA);
  schema.properties.developments.items.properties.evidence.items={anyOf:branches};return schema;
}

// Like research passage references: the model chooses evidence; the server copies the exact text.
export function textCitations(blocks) {
  const references=new Map(),text=new Map();
  for(const block of blocks){
    const raw=String(block.promptText??block.content.text??'');
    const chunks=[];
    for(let offset=0;offset<raw.length;offset+=650){
      const quote=raw.slice(offset,offset+650).trim();
      if(!quote)continue;
      const id=`finn-text:${block.id}:${chunks.length+1}`;
      // Selected passages may contain editorial separators; those must never become evidence.
      if(!normalise(block.content.text||'').includes(normalise(quote))){chunks.push(quote);continue;}
      references.set(id,{block_id:block.id,quote});chunks.push(`[${id}]\n${quote}`);
    }
    text.set(block.id,chunks.length?chunks.join('\n\n'):raw);
  }
  return {text,schema({coveredIds,images,disclosure}){
    const branches=[];
    for(const block of coveredIds){
      const ids=[...references].filter(([,r])=>r.block_id===block).map(([id])=>id);
      if(ids.length)branches.push(citationBranch(block,'text',ids));
    }
    for(const image of images)branches.push(citationBranch(image.blockId,'visual'));
    const leaves=value=>value&&typeof value==='object'?Object.values(value).flatMap(leaves):[String(value??'')];
    const metadata=[...new Set([disclosure.title,...leaves(disclosure.raw_metadata)].filter(v=>typeof v==='string'&&v.trim()&&v.length<=3000))];
    if(metadata.length)branches.push(citationBranch(null,'metadata',metadata));
    return branches.length?schemaWithCitations(branches):RESPONSE_SCHEMA;
  },resolve(value){
    const result=structuredClone(value);
    for(const development of result.developments||[])for(const citation of development.evidence||[]){
      if(citation.modality!=='text'||!String(citation.quote).trim().startsWith('finn-text:'))continue;
      const reference=references.get(citation.quote.trim());
      if(!reference||reference.block_id!==citation.block_id)throw Error('Unknown or mismatched source-text citation reference');
      citation.quote=reference.quote;
    }
    return result;
  }};
}

export function synthesisCitations(sources){
  const encoded=structuredClone(sources),references=new Map();
  for(const source of encoded)for(const development of source.developments)for(const citation of development.evidence){
    const id=`finn-evidence:${references.size+1}`;
    references.set(id,{...citation});citation.quote=id;
  }
  const groups=new Map();
  for(const [id,citation] of references){
    const key=JSON.stringify([citation.block_id,citation.modality]);
    if(!groups.has(key))groups.set(key,{...citation,ids:[]});groups.get(key).ids.push(id);
  }
  return {sources:encoded,schema:groups.size?schemaWithCitations([...groups.values()].map(c=>citationBranch(c.block_id,c.modality,c.ids))):RESPONSE_SCHEMA,resolve(value){
    const result=structuredClone(value);
    for(const development of result.developments||[])for(const citation of development.evidence||[]){
      if(!String(citation.quote).trim().startsWith('finn-evidence:'))continue;
      const original=references.get(citation.quote.trim());
      if(!original||original.block_id!==citation.block_id||original.modality!==citation.modality)throw Error('Unknown or mismatched validated-evidence reference');
      citation.quote=original.quote;
    }
    return result;
  }};
}
