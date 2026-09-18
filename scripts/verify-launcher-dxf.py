"""Read-only reference verification. Usage: python verify-launcher-dxf.py source.dxf

Requires ezdxf. The private source is never copied into the repository.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import ezdxf

source = Path(sys.argv[1])
expected_hash = 'a25f8cd0432aee998ab71daecc34083497dc182fd3271dc25d54e804d1a2cf5e'
if hashlib.sha256(source.read_bytes()).hexdigest() != expected_hash:
    raise ValueError('Unexpected DXF reference hash')
model = ezdxf.readfile(source).modelspace()
cx, cy = -774.424261555109, 119.1626597138509
segments = {}
for entity in model:
    handle = entity.dxf.handle
    if int(handle, 16) not in range(0xA92, 0xAAA):
        continue
    if entity.dxftype() == 'ARC':
        points = list(entity.flattening(0.005))  # Includes OCS -> WCS.
    elif entity.dxftype() == 'LINE':
        points = [entity.dxf.start, entity.dxf.end]
    else:
        raise ValueError('Unexpected interface entity')
    segments[int(handle, 16)] = [(p.x - cx, p.y - cy) for p in points]

loops = []
for first in (0xA92, 0xA9A, 0xAA2):
    points = segments[first][:]
    for handle in range(first + 1, first + 8):
        following = segments[handle]
        if math.dist(points[-1], following[0]) > 1e-6:
            raise ValueError('Unexpected interior join gap')
        points.extend(following[1:])
    gap = math.dist(points[-1], points[0])
    if abs(gap - 0.0111492470288) > 1e-9:
        raise ValueError('Unexpected closure gap')
    loops.append(points)

template = (Path(__file__).resolve().parents[1] / 'src/domain/outline-assembly/dxf-launcher.ts').read_text()
stored = [tuple(map(float, match)) for match in re.findall(
    r'Object.freeze\(\[(-?[\d.]+), (-?[\d.]+)\] as const\)', template)]
reference = [p for loop in loops for p in loop]
if len(stored) != len(reference):
    raise ValueError('Point count differs from the DXF')
error = max(math.dist(a, b) for a, b in zip(stored, reference))
if error > 1e-9:
    raise ValueError('Template differs from the transformed DXF')
print(json.dumps({'sourceHashVerified': True, 'loops': len(loops),
                  'points': len(stored), 'maximumCoordinateErrorMm': error}))
