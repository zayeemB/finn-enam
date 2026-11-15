import { hash } from '../sources.js';

export async function loadInput(db,job) {
  const disclosure=(await db.query('SELECT d.*,c.nse_symbol,c.name AS company_name FROM disclosures d JOIN companies c ON c.id=d.company_id WHERE d.id=$1',[job.disclosure_id])).rows[0];
  const assets=(await db.query('SELECT * FROM assets WHERE disclosure_id=$1 AND is_current ORDER BY source_url',[job.disclosure_id])).rows;
  const blocks=[],limitations=[];
  for (const asset of assets) {
    if (asset.extraction_status==='unsupported' || asset.download_status==='unsupported') {
      limitations.push(`Unsupported attachment ${asset.filename || asset.source_url}: ${asset.extraction_error || asset.download_error || asset.media_type}`); continue;
    }
    if (asset.download_status!=='downloaded' || asset.extraction_status!=='complete') throw new Error('Disclosure extraction is not complete');
    const pages=(await db.query(`SELECT id,asset_id,asset_content_hash,location,sequence,temporary_image_path,processor_version,
      jsonb_build_object('text',content->'text','text_status',content->'text_status','annotations',content->'annotations',
        'text_indexed',content->'text_indexed','image_storage_backend',content->'image_storage_backend','image_sha256',content->'image_sha256') AS content
      FROM content_blocks WHERE asset_id=$1 AND asset_content_hash=$2
      AND processor_version=$3 ORDER BY sequence`,[asset.id,asset.content_hash,asset.extraction_processor_version])).rows;
    if (pages.length!==asset.extraction_metadata?.totalPages || pages.some((p,i)=>p.sequence!==i+1 || !p.temporary_image_path&&!p.content.text_indexed)) throw new Error('Page coverage is incomplete');
    blocks.push(...pages.map(block=>({...block,asset})));
  }
  const priorEvents=(await db.query(`SELECT * FROM events WHERE company_id=$1 AND updated_at>=$2 ORDER BY updated_at DESC LIMIT 50`,
  [disclosure.company_id,new Date(+new Date(disclosure.published_at)-90*86400000)])).rows;
  return {disclosure,assets,blocks,limitations,priorEvents};
}

export async function pageImage(files,block) {
  let bytes;
  try {
    if (block.content.image_storage_backend!==files.backend) throw Object.assign(new Error('Page image storage backend unavailable'),{code:'ENOENT'});
    bytes=await files.get(block.temporary_image_path);
    if (hash(bytes)!==block.content.image_sha256) throw Object.assign(new Error('Page image checksum mismatch'),{code:'ENOENT'});
  } catch (error) { if (error.code==='ENOENT' || error.name==='BlobNotFoundError') error.missingAsset=block.asset; throw error; }
  let mimeType='image/png';
  if (bytes.length>3*1024*1024) {
    const {createCanvas,loadImage}=await import('@napi-rs/canvas');
    const image=await loadImage(bytes),canvas=createCanvas(image.width,image.height);
    canvas.getContext('2d').drawImage(image,0,0);
    bytes=canvas.toBuffer('image/jpeg',85); mimeType='image/jpeg';
  }
  return {blockId:block.id,bytes,mimeType};
}
