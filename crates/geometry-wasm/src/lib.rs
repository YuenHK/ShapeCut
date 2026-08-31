use std::fmt;

pub const RESULT_VERSION: u32 = 1;
pub const STATUS_OK: u32 = 0;
pub const STATUS_GEOMETRY_EVIDENCE: u32 = 1;

pub const DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT: usize = 0;
pub const DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT: usize = 1;
pub const DIAGNOSTIC_NON_FINITE_INPUT_COUNT: usize = 2;
pub const DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT: usize = 3;
pub const DIAGNOSTIC_SEGMENT_COUNT: usize = 4;
pub const DIAGNOSTIC_CHECKPOINT_COUNT: usize = 5;
pub const DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT: usize = 6;
pub const DIAGNOSTIC_ON_PLANE_EDGE_COUNT: usize = 7;
pub const DIAGNOSTIC_COUNTER_COUNT: usize = 8;

pub const MAX_VERTEX_COUNT: usize = 3_145_728;
pub const MAX_TRIANGLE_COUNT: usize = 1_048_576;
pub const MAX_PLANE_COUNT: usize = 16_384;
pub const MAX_PLANE_TRIANGLE_TESTS: usize = 250_000_000;
pub const MAX_SEGMENT_COUNT: usize = 8_388_608;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SliceKernelErrorCode {
    IncompletePositions,
    NonFinitePosition,
    VertexCountLimit,
    IncompleteTriangleIndices,
    TriangleCountLimit,
    IndexOutOfRange,
    NonFinitePlane,
    UnsortedPlanes,
    PlaneCountLimit,
    InvalidCheckpointInterval,
    WorkLimit,
    OutputLimit,
    AllocationFailed,
    IntegerOverflow,
}

impl SliceKernelErrorCode {
    fn message(self) -> &'static str {
        match self {
            Self::IncompletePositions => "positions must contain complete xyz vertices",
            Self::NonFinitePosition => "positions must contain only finite values",
            Self::VertexCountLimit => "vertex count exceeds the kernel limit",
            Self::IncompleteTriangleIndices => "indices must contain complete triangle triplets",
            Self::TriangleCountLimit => "triangle count exceeds the kernel limit",
            Self::IndexOutOfRange => "triangle index is outside the position buffer",
            Self::NonFinitePlane => "planes must contain only finite values",
            Self::UnsortedPlanes => "planes must be strictly increasing",
            Self::PlaneCountLimit => "plane count exceeds the kernel limit",
            Self::InvalidCheckpointInterval => "deadline check interval must be positive",
            Self::WorkLimit => "plane-triangle work exceeds the kernel limit",
            Self::OutputLimit => "segment output exceeds the kernel limit",
            Self::AllocationFailed => "kernel allocation failed",
            Self::IntegerOverflow => "kernel integer calculation overflowed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SliceKernelError {
    code: SliceKernelErrorCode,
}

impl SliceKernelError {
    fn new(code: SliceKernelErrorCode) -> Self {
        Self { code }
    }

    pub fn code(&self) -> SliceKernelErrorCode {
        self.code
    }
}

impl fmt::Display for SliceKernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.message())
    }
}

impl std::error::Error for SliceKernelError {}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub struct SliceBatchResult {
    version: u32,
    status_code: u32,
    plane_offsets: Vec<u32>,
    endpoints: Vec<f64>,
    diagnostic_counters: Vec<u32>,
}

impl SliceBatchResult {
    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn status_code(&self) -> u32 {
        self.status_code
    }

    pub fn plane_offsets(&self) -> &[u32] {
        &self.plane_offsets
    }

    pub fn endpoints(&self) -> &[f64] {
        &self.endpoints
    }

    pub fn diagnostic_counters(&self) -> &[u32] {
        &self.diagnostic_counters
    }
}

#[derive(Clone, Copy)]
struct Vertex {
    x: f64,
    y: f64,
    z: f64,
}

impl Vertex {
    fn from_positions(positions: &[f32], index: usize) -> Self {
        let offset = index * 3;
        Self {
            x: f64::from(positions[offset]),
            y: f64::from(positions[offset + 1]),
            z: f64::from(positions[offset + 2]),
        }
    }
}

fn triangle_vertices(
    positions: &[f32],
    triangle: &[u32; 3],
) -> Result<[Vertex; 3], SliceKernelError> {
    let first = usize::try_from(triangle[0])
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let second = usize::try_from(triangle[1])
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let third = usize::try_from(triangle[2])
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    Ok([
        Vertex::from_positions(positions, first),
        Vertex::from_positions(positions, second),
        Vertex::from_positions(positions, third),
    ])
}

fn allocation_error<T>(_: std::collections::TryReserveError) -> Result<T, SliceKernelError> {
    Err(SliceKernelError::new(
        SliceKernelErrorCode::AllocationFailed,
    ))
}

fn checked_increment(counter: &mut u32) -> Result<(), SliceKernelError> {
    *counter = counter
        .checked_add(1)
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    Ok(())
}

fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

fn push_segment(
    endpoints: &mut Vec<f64>,
    first: (f64, f64),
    second: (f64, f64),
) -> Result<(), SliceKernelError> {
    let segment_count = endpoints.len() / 4;
    if segment_count >= MAX_SEGMENT_COUNT {
        return Err(SliceKernelError::new(SliceKernelErrorCode::OutputLimit));
    }
    endpoints.try_reserve_exact(4).or_else(allocation_error)?;
    endpoints.extend_from_slice(&[
        canonical_zero(first.0),
        canonical_zero(first.1),
        canonical_zero(second.0),
        canonical_zero(second.1),
    ]);
    Ok(())
}

fn validate_request(
    positions: &[f32],
    indices: &[u32],
    planes: &[f64],
    deadline_check_interval: u32,
) -> Result<(usize, usize, f64, f64), SliceKernelError> {
    if deadline_check_interval == 0 {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::InvalidCheckpointInterval,
        ));
    }
    if !positions.len().is_multiple_of(3) {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::IncompletePositions,
        ));
    }
    if !indices.len().is_multiple_of(3) {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::IncompleteTriangleIndices,
        ));
    }

    let vertex_count = positions.len() / 3;
    if vertex_count > MAX_VERTEX_COUNT {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::VertexCountLimit,
        ));
    }
    let triangle_count = indices.len() / 3;
    if triangle_count > MAX_TRIANGLE_COUNT {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::TriangleCountLimit,
        ));
    }
    if planes.len() > MAX_PLANE_COUNT {
        return Err(SliceKernelError::new(SliceKernelErrorCode::PlaneCountLimit));
    }
    let work = triangle_count
        .checked_mul(planes.len())
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    if work > MAX_PLANE_TRIANGLE_TESTS {
        return Err(SliceKernelError::new(SliceKernelErrorCode::WorkLimit));
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut min_z = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut max_z = f64::NEG_INFINITY;
    for chunk in positions.as_chunks::<3>().0 {
        if chunk.iter().any(|value| !value.is_finite()) {
            return Err(SliceKernelError::new(
                SliceKernelErrorCode::NonFinitePosition,
            ));
        }
        let x = f64::from(chunk[0]);
        let y = f64::from(chunk[1]);
        let z = f64::from(chunk[2]);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        min_z = min_z.min(z);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        max_z = max_z.max(z);
    }
    for (plane_index, plane) in planes.iter().copied().enumerate() {
        if !plane.is_finite() {
            return Err(SliceKernelError::new(SliceKernelErrorCode::NonFinitePlane));
        }
        if plane_index > 0 && plane <= planes[plane_index - 1] {
            return Err(SliceKernelError::new(SliceKernelErrorCode::UnsortedPlanes));
        }
    }
    for index in indices.iter().copied() {
        let index = usize::try_from(index)
            .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
        if index >= vertex_count {
            return Err(SliceKernelError::new(SliceKernelErrorCode::IndexOutOfRange));
        }
    }

    let planar_diameter = if vertex_count == 0 {
        0.0
    } else {
        (max_x - min_x).hypot(max_y - min_y)
    };
    let spatial_diameter = if vertex_count == 0 {
        0.0
    } else {
        (max_x - min_x).hypot(max_y - min_y).hypot(max_z - min_z)
    };
    Ok((
        vertex_count,
        triangle_count,
        1e-9_f64.max(planar_diameter * 1e-10),
        1e-18_f64.max(spatial_diameter * spatial_diameter * 1e-12),
    ))
}

fn is_degenerate(vertices: [Vertex; 3], area_tolerance: f64) -> bool {
    let ab = (
        vertices[1].x - vertices[0].x,
        vertices[1].y - vertices[0].y,
        vertices[1].z - vertices[0].z,
    );
    let ac = (
        vertices[2].x - vertices[0].x,
        vertices[2].y - vertices[0].y,
        vertices[2].z - vertices[0].z,
    );
    let cross = (
        ab.1 * ac.2 - ab.2 * ac.1,
        ab.2 * ac.0 - ab.0 * ac.2,
        ab.0 * ac.1 - ab.1 * ac.0,
    );
    let area_measure = cross.0.hypot(cross.1).hypot(cross.2);
    area_measure <= area_tolerance
}

fn interpolate(
    first: Vertex,
    second: Vertex,
    first_distance: f64,
    second_distance: f64,
) -> (f64, f64) {
    let ratio = first_distance / (first_distance - second_distance);
    (
        first.x + (second.x - first.x) * ratio,
        first.y + (second.y - first.y) * ratio,
    )
}

pub fn slice_layer_batch(
    positions: &[f32],
    indices: &[u32],
    planes: &[f64],
    deadline_check_interval: u32,
) -> Result<SliceBatchResult, SliceKernelError> {
    let (_, triangle_count, epsilon, area_tolerance) =
        validate_request(positions, indices, planes, deadline_check_interval)?;

    let mut degenerate = Vec::new();
    degenerate
        .try_reserve_exact(triangle_count)
        .or_else(allocation_error)?;
    let mut diagnostics = Vec::new();
    diagnostics
        .try_reserve_exact(DIAGNOSTIC_COUNTER_COUNT)
        .or_else(allocation_error)?;
    diagnostics.resize(DIAGNOSTIC_COUNTER_COUNT, 0_u32);
    let triangles = indices.as_chunks::<3>().0;
    for triangle in triangles {
        let vertices = triangle_vertices(positions, triangle)?;
        let triangle_is_degenerate = is_degenerate(vertices, area_tolerance);
        degenerate.push(triangle_is_degenerate);
        if triangle_is_degenerate {
            checked_increment(&mut diagnostics[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT])?;
        }
    }

    let offset_capacity = planes
        .len()
        .checked_add(1)
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let mut plane_offsets = Vec::new();
    plane_offsets
        .try_reserve_exact(offset_capacity)
        .or_else(allocation_error)?;
    plane_offsets.push(0);
    let mut endpoints = Vec::new();
    let interval = usize::try_from(deadline_check_interval)
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let mut work_index = 0usize;

    for plane in planes.iter().copied() {
        for (triangle_index, triangle) in triangles.iter().enumerate() {
            if work_index.is_multiple_of(interval) {
                checked_increment(&mut diagnostics[DIAGNOSTIC_CHECKPOINT_COUNT])?;
                if endpoints.len() / 4 > MAX_SEGMENT_COUNT {
                    return Err(SliceKernelError::new(SliceKernelErrorCode::OutputLimit));
                }
            }
            work_index = work_index
                .checked_add(1)
                .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            if degenerate[triangle_index] {
                continue;
            }

            let vertices = triangle_vertices(positions, triangle)?;
            let distances = [
                vertices[0].z - plane,
                vertices[1].z - plane,
                vertices[2].z - plane,
            ];
            if distances.iter().all(|distance| *distance > epsilon)
                || distances.iter().all(|distance| *distance < -epsilon)
            {
                continue;
            }
            let on_plane = [
                distances[0].abs() <= epsilon,
                distances[1].abs() <= epsilon,
                distances[2].abs() <= epsilon,
            ];
            let on_plane_count = on_plane.iter().filter(|value| **value).count();
            if on_plane_count == 3 {
                checked_increment(&mut diagnostics[DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT])?;
                continue;
            }
            if on_plane_count == 2 {
                for edge in 0..3 {
                    let next = (edge + 1) % 3;
                    if on_plane[edge] && on_plane[next] {
                        push_segment(
                            &mut endpoints,
                            (vertices[edge].x, vertices[edge].y),
                            (vertices[next].x, vertices[next].y),
                        )?;
                        checked_increment(&mut diagnostics[DIAGNOSTIC_ON_PLANE_EDGE_COUNT])?;
                        break;
                    }
                }
                continue;
            }
            if on_plane_count == 1 {
                let vertex_index = on_plane
                    .iter()
                    .position(|value| *value)
                    .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
                let others = match vertex_index {
                    0 => [1, 2],
                    1 => [0, 2],
                    _ => [0, 1],
                };
                if distances[others[0]] * distances[others[1]] >= 0.0 {
                    continue;
                }
                push_segment(
                    &mut endpoints,
                    (vertices[vertex_index].x, vertices[vertex_index].y),
                    interpolate(
                        vertices[others[0]],
                        vertices[others[1]],
                        distances[others[0]],
                        distances[others[1]],
                    ),
                )?;
                continue;
            }

            let mut intersections = [(0.0, 0.0); 3];
            let mut intersection_count = 0usize;
            for edge in 0..3 {
                let next = (edge + 1) % 3;
                let first_distance = distances[edge];
                let second_distance = distances[next];
                if (first_distance < -epsilon && second_distance > epsilon)
                    || (first_distance > epsilon && second_distance < -epsilon)
                {
                    intersections[intersection_count] = interpolate(
                        vertices[edge],
                        vertices[next],
                        first_distance,
                        second_distance,
                    );
                    intersection_count += 1;
                }
            }
            if intersection_count != 2
                || (intersections[0].0 - intersections[1].0)
                    .hypot(intersections[0].1 - intersections[1].1)
                    <= epsilon
            {
                checked_increment(&mut diagnostics[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT])?;
                continue;
            }
            push_segment(&mut endpoints, intersections[0], intersections[1])?;
        }
        let segment_count = endpoints.len() / 4;
        plane_offsets.push(
            u32::try_from(segment_count)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?,
        );
    }

    diagnostics[DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT] = u32::try_from(work_index)
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    diagnostics[DIAGNOSTIC_SEGMENT_COUNT] = u32::try_from(endpoints.len() / 4)
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let has_geometry_evidence = diagnostics[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT] > 0
        || diagnostics[DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT] > 0
        || diagnostics[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT] > 0;

    Ok(SliceBatchResult {
        version: RESULT_VERSION,
        status_code: if has_geometry_evidence {
            STATUS_GEOMETRY_EVIDENCE
        } else {
            STATUS_OK
        },
        plane_offsets,
        endpoints,
        diagnostic_counters: diagnostics,
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{SliceBatchResult, slice_layer_batch};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    impl SliceBatchResult {
        #[wasm_bindgen(getter, js_name = version)]
        pub fn wasm_version(&self) -> u32 {
            self.version()
        }

        #[wasm_bindgen(getter, js_name = statusCode)]
        pub fn wasm_status_code(&self) -> u32 {
            self.status_code()
        }

        #[wasm_bindgen(getter, js_name = planeOffsets)]
        pub fn wasm_plane_offsets(&self) -> Box<[u32]> {
            self.plane_offsets().into()
        }

        #[wasm_bindgen(getter, js_name = endpoints)]
        pub fn wasm_endpoints(&self) -> Box<[f64]> {
            self.endpoints().into()
        }

        #[wasm_bindgen(getter, js_name = diagnosticCounters)]
        pub fn wasm_diagnostic_counters(&self) -> Box<[u32]> {
            self.diagnostic_counters().into()
        }
    }

    #[wasm_bindgen(js_name = slice_layer_batch)]
    pub fn slice_layer_batch_wasm(
        positions: &[f32],
        indices: &[u32],
        planes: &[f64],
        deadline_check_interval: u32,
    ) -> Result<SliceBatchResult, JsValue> {
        slice_layer_batch(positions, indices, planes, deadline_check_interval)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}
