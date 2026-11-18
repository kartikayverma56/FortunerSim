import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]);
const magic = buf.toString('ascii', 0, 4); const jsonLen = buf.readUInt32LE(12);
const j = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
console.log('magic', magic, 'version', buf.readUInt32LE(4), 'bytes', buf.length);
console.log('asset', JSON.stringify(j.asset));
console.log('extensionsUsed', j.extensionsUsed, 'required', j.extensionsRequired);
console.log('nodes', j.nodes?.length, 'meshes', j.meshes?.length, 'materials', j.materials?.length, 'textures', j.textures?.length, 'images', j.images?.length, 'animations', j.animations?.length);
let tris = 0; for (const m of j.meshes || []) for (const p of m.primitives) { const acc = p.indices != null ? j.accessors[p.indices] : j.accessors[p.attributes.POSITION]; tris += (p.indices != null ? acc.count / 3 : acc.count / 3); }
console.log('triangles ~', Math.round(tris));
const attrs = new Set(); for (const m of j.meshes || []) for (const p of m.primitives) Object.keys(p.attributes).forEach(a => attrs.add(a)); console.log('attributes', [...attrs].join(','));
// print hierarchy (names) depth-first, max 400 lines
const lines = []; const walk = (i, d) => { const n = j.nodes[i]; lines.push('  '.repeat(d) + (n.name || '#' + i) + (n.mesh != null ? ' [mesh]' : '') + (n.translation ? ' t=' + n.translation.map(x => x.toFixed(3)).join(',') : '') + (n.scale ? ' s=' + n.scale.map(x => +x.toFixed(4)).join(',') : '') + (n.rotation ? ' r' : '')); (n.children || []).forEach(c => walk(c, d + 1)); };
for (const s of j.scenes[j.scene || 0].nodes) walk(s, 0);
console.log(lines.length + ' nodes in scene'); console.log(lines.slice(0, Number(process.argv[3] || 200)).join('\n'));
