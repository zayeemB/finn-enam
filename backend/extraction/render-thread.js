// Parsing/rendering lives off the request thread so a slow PDF can be terminated.
import { parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

let pdf, loadingTask, image, options;
const sourceRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));

function sizeFor(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid page/image dimensions');
  const scale = Math.min(options.scale, Math.sqrt(options.maxPixels / (width * height)), 4096 / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

function textOf(items) {
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    text += item.hasEOL ? '\n' : ' ';
  }
  return text.trimEnd();
}

async function open(bytes, config) {
  options = config;
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 1024).toString('latin1').trimStart().startsWith('%PDF-')) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    loadingTask = getDocument({ data: new Uint8Array(bytes),
      cMapUrl: join(sourceRoot, 'cmaps') + sep, cMapPacked: true,
      standardFontDataUrl: join(sourceRoot, 'standard_fonts') + sep,
      wasmUrl: join(sourceRoot, 'wasm') + sep, isEvalSupported: false,
      useSystemFonts: false, stopAtErrors: true, enableXfa: false, verbosity: 0 });
    pdf = await loadingTask.promise;
    if (pdf.isPureXfa) throw Object.assign(new Error('Dynamic XFA documents are not supported'), { unsupported: true });
    if (!pdf.numPages || pdf.numPages > 5000) throw Object.assign(new Error('PDF page count outside supported limits (1–5000)'), { unsupported: true });
    const attachments = await pdf.getAttachments();
    const attachmentEntries = attachments instanceof Map ? [...attachments.entries()] : Object.entries(attachments || {});
    return { format: 'pdf', totalPages: pdf.numPages,
      embeddedAttachments: attachmentEntries.map(([name, a]) => ({ name, filename: a.filename, bytes: a.content?.length ?? null })) };
  }
  // Raster inputs are retained as full-page images for the vision stage.
  const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (!png && !jpeg) throw Object.assign(new Error('Supported extraction formats are PDF, PNG, and JPEG'), { unsupported: true });
  if (png) {
    if (buffer.length < 24 || buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 40000000) throw new Error('Raster image exceeds 40 megapixel decode limit');
    // Animated PNG needs every frame; do not silently keep only the first.
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL') throw Object.assign(new Error('Animated PNG is not supported'), { unsupported: true });
      offset += length + 12;
    }
  }
  if (jpeg) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset++] !== 255) continue;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0 || marker === 255 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
        if (width * height > 40000000) throw new Error('Raster image exceeds 40 megapixel decode limit');
        break;
      }
      offset += length;
    }
  }
  image = await loadImage(buffer);
  if (image.width * image.height > 40000000) throw new Error('Raster image exceeds 40 megapixel decode limit');
  return { format: png ? 'png' : 'jpeg', totalPages: 1, embeddedAttachments: [] };
}

async function page(number) {
  if (image) {
    const dimensions = sizeFor(image.width, image.height);
    const canvas = createCanvas(dimensions.width, dimensions.height);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { number, width: canvas.width, height: canvas.height,
      sourceWidth: image.width, sourceHeight: image.height, text: '', items: [], annotations: [],
      rotation: 0, renderTransform: [dimensions.scale,0,0,dimensions.scale,0,0],
      textError: null, image: new Uint8Array(canvas.toBuffer('image/png')) };
  }
  const source = await pdf.getPage(number);
  const base = source.getViewport({ scale: 1 });
  const dimensions = sizeFor(base.width, base.height);
  const viewport = source.getViewport({ scale: dimensions.scale });
  const target = pdf.canvasFactory.create(dimensions.width, dimensions.height);
  let textError = null, items = [];
  try {
    try { items = (await source.getTextContent({ includeMarkedContent: false, disableNormalization: true })).items
      .filter(i => typeof i.str === 'string').map(i => ({ text: i.str, transform: i.transform,
        width: i.width, height: i.height, direction: i.dir, font: i.fontName, hasEOL: i.hasEOL })); }
    catch (error) { textError = error.message; }
    await source.render({ canvasContext: target.context, viewport, background: 'rgb(255,255,255)' }).promise;
    const annotations = (await source.getAnnotations()).map(a => ({ id: a.id, subtype: a.subtype,
      rect: a.rect, text: a.contentsObj?.str || null, url: a.url || null,
      fieldName: a.fieldName, fieldValue: a.fieldValue }));
    return { number, width: dimensions.width, height: dimensions.height,
      sourceWidth: base.width, sourceHeight: base.height,
      rotation: source.rotate, renderTransform: viewport.transform,
      text: textOf(items.map(i => ({ ...i, str: i.text }))), items, annotations, textError,
      image: new Uint8Array(target.canvas.toBuffer('image/png')) };
  } finally { pdf.canvasFactory.destroy(target); source.cleanup(); }
}

async function indexText(){
  if(!pdf)return {pages:[{page:1,text:'',textError:null}]};
  const pages=[];
  for(let number=1;number<=pdf.numPages;number++){
    const source=await pdf.getPage(number);
    try{
      const content=await source.getTextContent({disableNormalization:true,includeMarkedContent:false});
      pages.push({page:number,text:textOf(content.items),textError:null});
    }catch(error){pages.push({page:number,text:'',textError:error.message});}
    finally{source.cleanup();}
  }
  return {pages};
}
parentPort.on('message', async message => {
  try {
    const result = message.action === 'open' ? await open(message.bytes, message.options) :
      message.action==='index'?await indexText():await page(message.page);
    const transfer = result.image ? [result.image.buffer] : [];
    parentPort.postMessage({ id: message.id, result }, transfer);
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message,
    unsupported: error.unsupported === true || error.name === 'PasswordException' }); }
});
