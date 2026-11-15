import {normalise} from './validation.js';

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
  return {text,resolve(value){
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
  return {sources:encoded,resolve(value){
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
