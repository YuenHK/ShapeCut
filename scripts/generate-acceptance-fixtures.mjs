import { mkdir, writeFile } from 'node:fs/promises';

const target = new URL('../fixtures/acceptance/', import.meta.url);
await mkdir(target, { recursive: true });

function lathed(name, radiusAt, { rings = 25, segments = 32, height = 36, angularTexture = 0, innerScale = 0 } = {}) {
  const vertices = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const t = ring / (rings - 1);
    const z = (t - 0.5) * height;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = segment * Math.PI * 2 / segments;
      const radius = Math.max(0.001, radiusAt(t) * (1 + angularTexture * Math.cos(angle * 8)));
      vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
  }
  const triangles = [];
  for (let ring = 0; ring < rings - 1; ring += 1) for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const a = ring * segments + segment, b = ring * segments + next, c = (ring + 1) * segments + next, d = (ring + 1) * segments + segment;
    triangles.push([a, b, c], [a, c, d]);
  }
  const capSurface = (offset = 0, reversed = false) => {
    const bottom = vertices.length;
    vertices.push([0, 0, vertices[offset][2]]);
    const top = vertices.length;
    vertices.push([0, 0, vertices[offset + (rings - 1) * segments][2]]);
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      triangles.push(reversed ? [bottom, offset + segment, offset + next] : [bottom, offset + next, offset + segment]);
      const topOffset = offset + (rings - 1) * segments;
      triangles.push(reversed ? [top, topOffset + next, topOffset + segment] : [top, topOffset + segment, topOffset + next]);
    }
  };
  capSurface();
  if (innerScale > 0) {
    const outerVertexCount = rings * segments;
    const offset = vertices.length;
    vertices.push(...vertices.slice(0, outerVertexCount).map(([x, y, z]) => [x * innerScale, y * innerScale, z * 0.82]));
    const outerSides = triangles.slice(0, (rings - 1) * segments * 2);
    triangles.push(...outerSides.map(([a, b, c]) => [offset + c, offset + b, offset + a]));
    capSurface(offset, true);
  }
  const facets = triangles.map((triangle) => `  facet normal 0 0 0\n    outer loop\n${triangle.map((index) => `      vertex ${vertices[index].join(' ')}`).join('\n')}\n    endloop\n  endfacet`).join('\n');
  return `solid ${name}\n${facets}\nendsolid ${name}\n`;
}

const smooth = (t) => 4 + 16 * Math.sin(Math.PI * t);
const fixtures = {
  'symmetric-smooth.stl': lathed('symmetric_smooth', smooth),
  'symmetric-textured.stl': lathed('symmetric_textured', smooth, { angularTexture: 0.035 }),
  'hollow-shell.stl': lathed('hollow_shell', smooth, { innerScale: 0.55 }),
  'wide-outer-ring.stl': lathed('wide_outer_ring', (t) => 5 + 20 * Math.sin(Math.PI * t) ** 0.55),
  'thin-profile.stl': lathed('thin_profile', smooth, { innerScale: 0.88 }),
  'tall-spindle.stl': lathed('tall_spindle', (t) => 3 + 12 * Math.sin(Math.PI * t), { height: 64 }),
  'squat-disc.stl': lathed('squat_disc', (t) => 6 + 22 * Math.sin(Math.PI * t), { height: 18 }),
  'stepped-profile.stl': lathed('stepped_profile', (t) => t < 0.22 || t > 0.78 ? 6 : t < 0.38 || t > 0.62 ? 14 : 20),
  'low-symmetry.stl': `solid low_symmetry
facet normal 0 0 0 outer loop
vertex 0 0 8
vertex -9 -5 -6
vertex 13 -4 -5
endloop endfacet
facet normal 0 0 0 outer loop
vertex 0 0 8
vertex 13 -4 -5
vertex 2 11 -3
endloop endfacet
facet normal 0 0 0 outer loop
vertex 0 0 8
vertex 2 11 -3
vertex -9 -5 -6
endloop endfacet
facet normal 0 0 0 outer loop
vertex -9 -5 -6
vertex 2 11 -3
vertex 13 -4 -5
endloop endfacet
endsolid low_symmetry
`,
  'invalid-open.stl': `solid invalid_open
facet normal 0 0 1 outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop endfacet
endsolid invalid_open
`,
};

for (const [file, contents] of Object.entries(fixtures)) await writeFile(new URL(file, target), contents);
