export function cleanStatement(text){
  return text.replace(/\[(?:(?:p\d+|followup\d+)\.(?:\d+|visual)(?:\s*,\s*)?)+\]/gi,'').replace(/\s+([.,;])/g,'$1').replace(/\s{2,}/g,' ').trim();
}
export const evidenceRequirements=[
  {topic:'cash_quality',question:'Find operating cash flow, profit after tax PAT, purchases of property plant equipment capex, and changes in inventories receivables payables, with statement periods and standalone or consolidated scope.'},
  {topic:'balance_sheet',question:'Find standalone borrowings and consolidated borrowings, finance subsidiary NBFC credit services segment liabilities and the manufacturing versus financial services scope.'},
  {topic:'narrative_vs_numbers',question:'Find management margin or commodity cost expectations and corresponding reported EBITDA margins or outcomes for the same period.'},
  {topic:'guidance',question:'Find explicit forward expectations or guidance for growth, sales volumes, margins or capital expenditure, including the stated period.'},
];
export function sectionQuality(topic,statement,evidence){
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
