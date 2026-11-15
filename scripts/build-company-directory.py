"""Build search snapshot from the public Upstox instrument JSON gzip. No market prices retained."""
import gzip,json,sys
from pathlib import Path
rows=json.loads(gzip.decompress(Path(sys.argv[1]).read_bytes()));by={}
for r in rows:
 segment=r.get('segment');kind=r.get('instrument_type')
 if segment not in ('NSE_EQ','BSE_EQ') or not r.get('isin','').startswith('INE'):continue
 if segment=='NSE_EQ' and kind not in ('EQ','BE','BZ','SM','ST','SZ'):continue
 if segment=='BSE_EQ' and kind not in ('A','B','X','XT','T','Z','M','MT','MS','ZP','TS'):continue
 d=by.setdefault(r['isin'],{'name':r['name'],'nse':None,'bse':None,'aliases':[]})
 if segment=='NSE_EQ':d['nse']=r['trading_symbol'];d['name']=r['name']
 else:d['bse']=str(r['exchange_token'])
 if r['trading_symbol'] not in d['aliases']:d['aliases'].append(r['trading_symbol'])
companies=sorted(by.values(),key=lambda d:d['name'])
Path('web/companies.json').write_text(json.dumps({'as_of':sys.argv[2],'source':'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz','companies':companies},separators=(',',':')))
print(len(companies),'companies;',sum(bool(c['nse']) for c in companies),'NSE;',sum(bool(c['bse']) for c in companies),'BSE')
