const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findPhotoFile } = require('../steps/upload-photos-to-rondo-club');

test('photo imports choose the new format instead of an old cached JPEG', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rondo-photo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jpg = path.join(dir, 'TEST001.jpg');
  const png = path.join(dir, 'TEST001.png');
  await fs.writeFile(jpg, 'old JPEG');
  await fs.writeFile(png, 'new PNG');
  await fs.utimes(jpg, 1000, 1000);
  await fs.utimes(png, 2000, 2000);
  assert.deepEqual(await findPhotoFile('TEST001', dir), { found: true, path: png, ext: 'png' });

  // A later switch back to JPEG must also replace the older PNG.
  await fs.writeFile(jpg, 'new JPEG');
  await fs.utimes(jpg, 3000, 3000);
  assert.deepEqual(await findPhotoFile('TEST001', dir), { found: true, path: jpg, ext: 'jpg' });

  // Files belonging to other members and directories are never candidates.
  await fs.writeFile(path.join(dir, 'OTHER.png'), 'other person');
  await fs.mkdir(path.join(dir, 'TEST001.webp'));
  assert.equal((await findPhotoFile('TEST001', dir)).path, jpg);
  assert.deepEqual(await findPhotoFile('MISSING', dir), { found: false, path: null, ext: null });
});
