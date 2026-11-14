import { createHash } from 'node:crypto';
export const hash = data => createHash('sha256').update(data).digest('hex');
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const inputHash = value => hash(stableJson(value));
export function symbol(value) {
  const clean = value.trim().toUpperCase().replace(/\.NS$/, '');
  if (!/^[A-Z0-9][A-Z0-9&_-]{0,29}$/.test(clean)) throw new Error(`Invalid NSE symbol: ${value}`);
  return clean;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function nseTimestamp(value) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value || '');
  if (!match || !MONTHS.includes(match[2])) throw new Error(`Unrecognised NSE timestamp: ${value}`);
  const iso = `${match[3]}-${String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1]}T${match[4]}+05:30`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid NSE timestamp: ${value}`);
  return date.toISOString();
}
export const indiaDay = date => new Date(+date + 19800000).toISOString().slice(0, 10);
const queryDay = day => day.split('-').reverse().join('-');
const PAGE = 'https://www.nseindia.com/companies-listing/corporate-filings-announcements';

export function parseDisclosures(payload, companySymbol, feedUrl) {
  if (!Array.isArray(payload)) throw new Error('NSE did not return a disclosure list');
  return payload.map(raw => {
    if (!raw || raw.symbol?.toUpperCase() !== companySymbol) throw new Error('NSE company identity mismatch');
    const attachment = raw.attchmntFile ? new URL(raw.attchmntFile, 'https://nsearchives.nseindia.com/').href : null;
    const published = nseTimestamp(raw.an_dt || raw.exchdisstime);
    return { source: 'nse', sourceKey: raw.seq_id ? String(raw.seq_id) :
      inputHash(attachment || [feedUrl.split('?')[0], published, raw.desc]),
    title: raw.desc || 'Untitled disclosure', sourceUrl: attachment || feedUrl,
    publishedAt: published, rawMetadata: raw,
    assets: attachment ? [{ sourceUrl: attachment }] : [] };
  });
}

export async function fetchDisclosures(client, companySymbol, start, end) {
  await client.get(PAGE);
  let cursor = new Date(`${indiaDay(start)}T00:00:00+05:30`);
  const found = new Map();
  while (indiaDay(cursor) <= indiaDay(end)) {
    const windowEnd = new Date(Math.min(+cursor + 29 * 86400000, +end));
    const query = new URLSearchParams({ index: 'equities', symbol: companySymbol,
      from_date: queryDay(indiaDay(cursor)), to_date: queryDay(indiaDay(windowEnd)) });
    const url = `https://www.nseindia.com/api/corporate-announcements?${query}`;
    const response = await client.get(url, { Referer: PAGE, Accept: 'application/json' });
    for (const row of parseDisclosures(response.json(), companySymbol, url)) {
      if (+new Date(row.publishedAt) >= +start && +new Date(row.publishedAt) <= +end) found.set(row.sourceKey, row);
    }
    cursor = new Date(+windowEnd + 86400000);
  }
  return [...found.values()];
}

export function parsePrices(payload, companySymbol, now) {
  const result = payload?.chart?.result?.[0];
  if (payload?.chart?.error || !result) throw new Error('Yahoo returned no price series');
  const meta = result.meta;
  if (meta?.symbol !== `${companySymbol}.NS` || meta.currency !== 'INR' || meta.exchangeTimezoneName !== 'Asia/Kolkata') throw new Error('Yahoo company/currency/timezone mismatch');
  const quotes = result.indicators?.quote?.[0];
  if (!quotes || !Array.isArray(result.timestamp)) throw new Error('Yahoo daily bars missing');
  const closeAt = meta.currentTradingPeriod?.regular?.end;
  const rows = [];
  for (const [i, stamp] of result.timestamp.entries()) {
    const day = indiaDay(new Date(stamp * 1000));
    if (day > indiaDay(now) || (day === indiaDay(now) && (!closeAt || indiaDay(new Date(closeAt * 1000)) !== day || +now < closeAt * 1000 + 1800000))) continue;
    const values = Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(k => [k, quotes[k]?.[i]]));
    if (Object.values(values).some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
      values.low <= 0 || values.low > Math.min(values.open, values.close) || values.high < Math.max(values.open, values.close) ||
      !Number.isSafeInteger(values.volume) || values.volume < 0) continue;
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose?.[i];
    if (typeof adjusted === 'number' && Number.isFinite(adjusted)) values.adjusted_close = adjusted;
    rows.push({ day, values });
  }
  if (!rows.length) throw new Error('No valid completed daily sessions');
  return { rows, corporateActions: result.events || {} };
}

export async function fetchPrices(client, companySymbol, start, end) {
  const params = new URLSearchParams({ period1: String(Math.floor(+start / 1000)),
    period2: String(Math.floor(+end / 1000)), interval: '1d', events: 'div,splits' });
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(companySymbol + '.NS')}?${params}`;
  const response = await client.get(url);
  return { ...parsePrices(response.json(), companySymbol, end), url };
}
