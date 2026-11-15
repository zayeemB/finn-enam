export function cleanStatement(text){
  return text.replace(/\[(?:(?:p\d+|followup\d+)\.(?:\d+|visual)(?:\s*,\s*)?)+\]/gi,'').replace(/\s+([.,;])/g,'$1').replace(/\s{2,}/g,' ').trim();
}
export const evidenceRequirements=[
  {topic:'cash_quality',question:'Find operating cash flow, profit after tax PAT, purchases of property plant equipment capex, and changes in inventories receivables payables, with statement periods and standalone or consolidated scope.'},
  {topic:'balance_sheet',question:'Find debt, liquidity, maturities and working capital with the stated reporting period and standalone or consolidated scope. Only separate financing subsidiaries when the sources establish that they exist.'},
  {topic:'narrative_vs_numbers',question:'Find management margin or commodity cost expectations and corresponding reported EBITDA margins or outcomes for the same period.'},
  {topic:'guidance',question:'Find explicit forward expectations or guidance for growth, sales volumes, margins or capital expenditure, including the stated period.'},
];
export function sectionQuality(topic,statement,evidence){
  const quoted=evidence.map(e=>e.quote||'').join(' ');
  if(/year ended/i.test(statement)&&/(?:six|6|three|3|nine|9)\s+months? ended/i.test(quoted)&&!/year ended/i.test(quoted))return {gap:'Verify the statement duration: cited evidence describes an interim period, not a full year.'};
  if(/CAGR|compound annual/i.test(statement)){
    const years=[...statement.matchAll(/FY\s*(20\d{2})/gi)].map(m=>Number(m[1]));
    const endpoints=/from\s+([\d,.]+).*?(?:to|rising to)\s+([\d,.]+)/i.exec(statement);
    const rate=/([\d.]+)\s*%/.exec(statement);
    if(!endpoints||years.length!==2||!rate)return {gap:'CAGR needs explicit starting and ending values, compatible periods, units and scope.'};
    const a=Number(endpoints[1].replaceAll(',','')),b=Number(endpoints[2].replaceAll(',','')),n=years[1]-years[0];
    if(a<=0||b<=0||n<=0||Math.abs(((b/a)**(1/n)-1)*100-Number(rate[1]))>0.15)return {gap:'The stated CAGR does not match the cited endpoints and annual intervals.'};
  }
  if(topic==='narrative_vs_numbers'&&(!/(?:guid|expect|target|forecast).{0,100}\d/i.test(statement)||!/(?:reported|actual|delivered|achieved).{0,100}\d/i.test(statement)))return {gap:'A matched comparison needs numerical management expectations and reported outcomes for the same metric, period and scope.'};
  if(topic==='guidance'&&/dividend|bonus|NCRPS|preference shares|buyback|distribution.*reserves/i.test(statement))return {topic:'capital_allocation'};
  if(topic==='guidance'&&/GDP|IMF|global economic/i.test(statement))return {gap:'Macroeconomic forecasts do not establish company operating guidance.'};
  if(topic==='guidance'&&(!/expect|guid|target|forecast|anticipat|outlook|aim/i.test(statement)||!/growth|margin|volume|sales|capex|capital expenditure|demand/i.test(statement)))
    return {gap:'No explicit operating guidance was established by this finding.'};
  if(topic==='narrative_vs_numbers'&&(!/\d/.test(statement.replace(/(?:FY\s*)?20\d{2}(?:[-–/]\d{2,4})?/gi,''))||!/versus|compared|while|despite|align|diverg|deliver|against|outcome|however|although/i.test(statement)))
    return {gap:'Management commentary needs a supported comparison with reported outcomes.'};
  if(topic==='trajectory'&&/IMF|global economic growth/i.test(statement)&&!/company|sales|revenue|volume/i.test(statement))return {gap:'Company trajectory needs company operating outcomes rather than global GDP projections.'};
  if(topic==='cash_quality'&&!/\d/.test(statement)&&!/cash flow|cash from operat|operating cash|cash conversion/i.test(statement))
    return {topic:'balance_sheet',gap:'Operating practices alone do not establish numerical cash conversion.'};
  if(topic==='bull_vs_bear'&&/subsidiar|EBCO/i.test(statement)&&(!/\d/.test(statement)||!/group|consolidated|share|contribution|revenue|profit|loss/i.test(statement)))
    return {gap:'The group-level materiality of the subsidiary risk was not established.'};
  return {topic};
}
