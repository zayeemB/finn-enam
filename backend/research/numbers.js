// Expand fiscal-year abbreviations before comparing numerical evidence.
export function numericTokens(text){
  const expanded=String(text).replace(/(?<!\d)((?:19|20)\d{2})\s*[-–/]\s*(\d{2})\b/g,
    (_match,start,end)=>start+' '+(Number(start.slice(0,2))+(Number(end)<Number(start.slice(2))?1:0))+end);
  return [...expanded.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(match=>Number(match[0].replaceAll(',','')));
}
