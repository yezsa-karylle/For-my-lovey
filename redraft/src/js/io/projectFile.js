// .redraft project files: a zip holding project.json plus the scan images.
const JSZip = window.JSZip;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export async function serializeProject(project, assets) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project), { compression: 'DEFLATE', compressionOptions: { level: 3 } });
  const meta = {};
  for (const [id, a] of assets) {
    const name = `assets/${id}.${EXT[a.mime] || 'bin'}`;
    meta[id] = { mime: a.mime, file: name };
    zip.file(name, a.bytes, { compression: 'STORE' });
  }
  zip.file('assets.json', JSON.stringify(meta));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

export async function loadProject(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const pj = zip.file('project.json');
  if (!pj) throw new Error('Not a Redraft project file');
  const project = JSON.parse(await pj.async('string'));
  if (project.format !== 'redraft') throw new Error('Not a Redraft project file');
  const meta = JSON.parse((await zip.file('assets.json')?.async('string')) || '{}');
  const assets = new Map();
  for (const [id, m] of Object.entries(meta)) {
    const f = zip.file(m.file);
    if (f) assets.set(id, { mime: m.mime, bytes: await f.async('uint8array') });
  }
  project.journal ||= [];
  project.swatches ||= [];
  return { project, assets };
}
