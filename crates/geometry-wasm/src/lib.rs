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
pub const DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT: usize = 8;
pub const DIAGNOSTIC_COUNTER_COUNT: usize = 9;

pub const MAX_VERTEX_COUNT: usize = 3_145_728;
pub const MAX_TRIANGLE_COUNT: usize = 1_048_576;
pub const MAX_PLANE_COUNT: usize = 16_384;
pub const MAX_PLANE_TRIANGLE_TESTS: usize = 250_000_000;
pub const MAX_SEGMENT_COUNT: usize = 262_144;
pub const MAX_DEADLINE_CHECK_INTERVAL: u32 = 4_096;
const MAX_ENDPOINT_VALUE_COUNT: usize = MAX_SEGMENT_COUNT * 4;
const MIN_ENDPOINT_ALLOCATION_VALUES: usize = 4_096;

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
    DeadlineCheckIntervalLimit,
    DeadlineCheckFailed,
    DeadlineExceeded,
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
            Self::InvalidCheckpointInterval => {
                "deadline check interval must be a finite safe positive integer"
            }
            Self::DeadlineCheckIntervalLimit => "deadline check interval exceeds the kernel limit",
            Self::DeadlineCheckFailed => "deadline check failed closed",
            Self::DeadlineExceeded => "slice batch was cancelled at a deadline checkpoint",
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

fn check_deadline<F>(abort_check: &mut F) -> Result<(), SliceKernelError>
where
    F: FnMut() -> Result<bool, SliceKernelErrorCode>,
{
    if abort_check().map_err(SliceKernelError::new)? {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::DeadlineExceeded,
        ));
    }
    Ok(())
}

fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

fn push_segment(
    endpoints: &mut Vec<f64>,
    diagnostics: &mut [u32],
    first: (f64, f64),
    second: (f64, f64),
) -> Result<(), SliceKernelError> {
    let segment_count = endpoints.len() / 4;
    if segment_count >= MAX_SEGMENT_COUNT {
        return Err(SliceKernelError::new(SliceKernelErrorCode::OutputLimit));
    }
    let required = endpoints
        .len()
        .checked_add(4)
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    if required > endpoints.capacity() {
        let doubled = endpoints
            .capacity()
            .checked_mul(2)
            .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
        let target = required
            .max(MIN_ENDPOINT_ALLOCATION_VALUES)
            .max(doubled)
            .min(MAX_ENDPOINT_VALUE_COUNT);
        let additional = target
            .checked_sub(endpoints.len())
            .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
        endpoints
            .try_reserve_exact(additional)
            .or_else(allocation_error)?;
        checked_increment(&mut diagnostics[DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT])?;
    }
    endpoints.extend_from_slice(&[
        canonical_zero(first.0),
        canonical_zero(first.1),
        canonical_zero(second.0),
        canonical_zero(second.1),
    ]);
    Ok(())
}

fn validate_request_lengths(
    position_length: usize,
    index_length: usize,
    plane_length: usize,
    deadline_check_interval: u32,
) -> Result<(usize, usize), SliceKernelError> {
    if deadline_check_interval == 0 {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::InvalidCheckpointInterval,
        ));
    }
    if deadline_check_interval > MAX_DEADLINE_CHECK_INTERVAL {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::DeadlineCheckIntervalLimit,
        ));
    }
    if !position_length.is_multiple_of(3) {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::IncompletePositions,
        ));
    }
    if !index_length.is_multiple_of(3) {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::IncompleteTriangleIndices,
        ));
    }

    let vertex_count = position_length / 3;
    if vertex_count > MAX_VERTEX_COUNT {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::VertexCountLimit,
        ));
    }
    let triangle_count = index_length / 3;
    if triangle_count > MAX_TRIANGLE_COUNT {
        return Err(SliceKernelError::new(
            SliceKernelErrorCode::TriangleCountLimit,
        ));
    }
    if plane_length > MAX_PLANE_COUNT {
        return Err(SliceKernelError::new(SliceKernelErrorCode::PlaneCountLimit));
    }
    let work = triangle_count
        .checked_mul(plane_length)
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    if work > MAX_PLANE_TRIANGLE_TESTS {
        return Err(SliceKernelError::new(SliceKernelErrorCode::WorkLimit));
    }

    Ok((vertex_count, triangle_count))
}

fn validate_request<F>(
    positions: &[f32],
    indices: &[u32],
    planes: &[f64],
    deadline_check_interval: u32,
    abort_check: &mut F,
) -> Result<usize, SliceKernelError>
where
    F: FnMut() -> Result<bool, SliceKernelErrorCode>,
{
    let (vertex_count, triangle_count) = validate_request_lengths(
        positions.len(),
        indices.len(),
        planes.len(),
        deadline_check_interval,
    )?;
    let interval = usize::try_from(deadline_check_interval)
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    for values in positions.chunks(interval) {
        check_deadline(abort_check)?;
        if values.iter().any(|value| !value.is_finite()) {
            return Err(SliceKernelError::new(
                SliceKernelErrorCode::NonFinitePosition,
            ));
        }
    }
    for (chunk_index, plane_chunk) in planes.chunks(interval).enumerate() {
        check_deadline(abort_check)?;
        let chunk_start = chunk_index
            .checked_mul(interval)
            .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
        for (local_index, plane) in plane_chunk.iter().copied().enumerate() {
            let plane_index = chunk_start
                .checked_add(local_index)
                .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            if !plane.is_finite() {
                return Err(SliceKernelError::new(SliceKernelErrorCode::NonFinitePlane));
            }
            if plane_index > 0 && plane <= planes[plane_index - 1] {
                return Err(SliceKernelError::new(SliceKernelErrorCode::UnsortedPlanes));
            }
        }
    }
    for index_chunk in indices.chunks(interval) {
        check_deadline(abort_check)?;
        for index in index_chunk.iter().copied() {
            let index = usize::try_from(index)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            if index >= vertex_count {
                return Err(SliceKernelError::new(SliceKernelErrorCode::IndexOutOfRange));
            }
        }
    }

    Ok(triangle_count)
}

fn edge_length(first: Vertex, second: Vertex) -> f64 {
    (second.x - first.x)
        .hypot(second.y - first.y)
        .hypot(second.z - first.z)
}

fn is_degenerate(vertices: [Vertex; 3]) -> bool {
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
    let local_edge_scale = edge_length(vertices[0], vertices[1])
        .max(edge_length(vertices[1], vertices[2]))
        .max(edge_length(vertices[2], vertices[0]));
    let area_tolerance =
        f64::MIN_POSITIVE.max(local_edge_scale * local_edge_scale * 64.0 * f64::EPSILON);
    area_measure <= area_tolerance
}

fn plane_tolerance(vertices: [Vertex; 3], plane: f64) -> f64 {
    let axial_magnitude = vertices.iter().fold(plane.abs().max(1.0), |scale, vertex| {
        scale.max(vertex.z.abs())
    });
    1e-9_f64.max(axial_magnitude * 64.0 * f64::EPSILON)
}

fn planar_tolerance(vertices: [Vertex; 3]) -> f64 {
    let planar_edge_scale = (vertices[1].x - vertices[0].x)
        .hypot(vertices[1].y - vertices[0].y)
        .max((vertices[2].x - vertices[1].x).hypot(vertices[2].y - vertices[1].y))
        .max((vertices[0].x - vertices[2].x).hypot(vertices[0].y - vertices[2].y));
    1e-9_f64.max(planar_edge_scale * 64.0 * f64::EPSILON)
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
    slice_layer_batch_with_abort_check(positions, indices, planes, deadline_check_interval, || {
        Ok(false)
    })
}

pub fn slice_layer_batch_with_abort_check<F>(
    positions: &[f32],
    indices: &[u32],
    planes: &[f64],
    deadline_check_interval: u32,
    mut abort_check: F,
) -> Result<SliceBatchResult, SliceKernelError>
where
    F: FnMut() -> Result<bool, SliceKernelErrorCode>,
{
    let triangle_count = validate_request(
        positions,
        indices,
        planes,
        deadline_check_interval,
        &mut abort_check,
    )?;
    let interval = usize::try_from(deadline_check_interval)
        .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;

    let mut degenerate = Vec::new();
    if triangle_count > 0 {
        check_deadline(&mut abort_check)?;
    }
    degenerate
        .try_reserve_exact(triangle_count)
        .or_else(allocation_error)?;
    let mut diagnostics = Vec::new();
    diagnostics
        .try_reserve_exact(DIAGNOSTIC_COUNTER_COUNT)
        .or_else(allocation_error)?;
    diagnostics.resize(DIAGNOSTIC_COUNTER_COUNT, 0_u32);
    let triangles = indices.as_chunks::<3>().0;
    for triangle_chunk in triangles.chunks(interval) {
        check_deadline(&mut abort_check)?;
        for triangle in triangle_chunk {
            let vertices = triangle_vertices(positions, triangle)?;
            let triangle_is_degenerate = is_degenerate(vertices);
            degenerate.push(triangle_is_degenerate);
            if triangle_is_degenerate {
                checked_increment(&mut diagnostics[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT])?;
            }
        }
    }

    let offset_capacity = planes
        .len()
        .checked_add(1)
        .ok_or_else(|| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
    let mut plane_offsets = Vec::new();
    if offset_capacity > 1 {
        check_deadline(&mut abort_check)?;
    }
    plane_offsets
        .try_reserve_exact(offset_capacity)
        .or_else(allocation_error)?;
    plane_offsets.push(0);
    let mut endpoints = Vec::new();
    let mut work_index = 0usize;

    for plane in planes.iter().copied() {
        for (triangle_index, triangle) in triangles.iter().enumerate() {
            if work_index.is_multiple_of(interval) {
                checked_increment(&mut diagnostics[DIAGNOSTIC_CHECKPOINT_COUNT])?;
                check_deadline(&mut abort_check)?;
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
            let epsilon = plane_tolerance(vertices, plane);
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
                            &mut diagnostics,
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
                    &mut diagnostics,
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
                    <= planar_tolerance(vertices)
            {
                checked_increment(&mut diagnostics[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT])?;
                continue;
            }
            push_segment(
                &mut endpoints,
                &mut diagnostics,
                intersections[0],
                intersections[1],
            )?;
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
        || diagnostics[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT] > 0
        || diagnostics[DIAGNOSTIC_ON_PLANE_EDGE_COUNT] > 0;

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
    use super::{
        MAX_DEADLINE_CHECK_INTERVAL, SliceBatchResult, SliceKernelError, SliceKernelErrorCode,
        allocation_error, check_deadline, slice_layer_batch_with_abort_check,
        validate_request_lengths,
    };
    use js_sys::{Float32Array, Float64Array, Uint32Array};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(
            js_namespace = globalThis,
            js_name = __shapecut_geometry_should_abort,
            catch
        )]
        fn deadline_should_abort() -> Result<JsValue, JsValue>;
    }

    impl From<SliceKernelError> for JsValue {
        fn from(error: SliceKernelError) -> Self {
            JsValue::from_str(&error.to_string())
        }
    }

    fn array_length(length: u32) -> Result<usize, SliceKernelError> {
        usize::try_from(length)
            .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))
    }

    fn parse_deadline_check_interval(value: &JsValue) -> Result<u32, SliceKernelError> {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
        let number = value.as_f64().ok_or_else(|| {
            SliceKernelError::new(SliceKernelErrorCode::InvalidCheckpointInterval)
        })?;
        if !number.is_finite()
            || number <= 0.0
            || number.fract() != 0.0
            || number > MAX_SAFE_INTEGER
        {
            return Err(SliceKernelError::new(
                SliceKernelErrorCode::InvalidCheckpointInterval,
            ));
        }
        if number > f64::from(MAX_DEADLINE_CHECK_INTERVAL) {
            return Err(SliceKernelError::new(
                SliceKernelErrorCode::DeadlineCheckIntervalLimit,
            ));
        }
        Ok(number as u32)
    }

    fn copy_float32<F>(
        array: &Float32Array,
        length: usize,
        interval: usize,
        abort_check: &mut F,
    ) -> Result<Vec<f32>, SliceKernelError>
    where
        F: FnMut() -> Result<bool, SliceKernelErrorCode>,
    {
        let mut values = Vec::new();
        if length > 0 {
            check_deadline(abort_check)?;
        }
        values.try_reserve_exact(length).or_else(allocation_error)?;
        values.resize(length, 0.0);
        for start in (0..length).step_by(interval) {
            check_deadline(abort_check)?;
            let end = start.saturating_add(interval).min(length);
            let start_index = u32::try_from(start)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            let end_index = u32::try_from(end)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            array
                .subarray(start_index, end_index)
                .copy_to(&mut values[start..end]);
        }
        Ok(values)
    }

    fn copy_uint32<F>(
        array: &Uint32Array,
        length: usize,
        interval: usize,
        abort_check: &mut F,
    ) -> Result<Vec<u32>, SliceKernelError>
    where
        F: FnMut() -> Result<bool, SliceKernelErrorCode>,
    {
        let mut values = Vec::new();
        if length > 0 {
            check_deadline(abort_check)?;
        }
        values.try_reserve_exact(length).or_else(allocation_error)?;
        values.resize(length, 0);
        for start in (0..length).step_by(interval) {
            check_deadline(abort_check)?;
            let end = start.saturating_add(interval).min(length);
            let start_index = u32::try_from(start)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            let end_index = u32::try_from(end)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            array
                .subarray(start_index, end_index)
                .copy_to(&mut values[start..end]);
        }
        Ok(values)
    }

    fn copy_float64<F>(
        array: &Float64Array,
        length: usize,
        interval: usize,
        abort_check: &mut F,
    ) -> Result<Vec<f64>, SliceKernelError>
    where
        F: FnMut() -> Result<bool, SliceKernelErrorCode>,
    {
        let mut values = Vec::new();
        if length > 0 {
            check_deadline(abort_check)?;
        }
        values.try_reserve_exact(length).or_else(allocation_error)?;
        values.resize(length, 0.0);
        for start in (0..length).step_by(interval) {
            check_deadline(abort_check)?;
            let end = start.saturating_add(interval).min(length);
            let start_index = u32::try_from(start)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            let end_index = u32::try_from(end)
                .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
            array
                .subarray(start_index, end_index)
                .copy_to(&mut values[start..end]);
        }
        Ok(values)
    }

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

        #[wasm_bindgen(getter, js_name = planeOffsetsPtr)]
        pub fn wasm_plane_offsets_ptr(&self) -> usize {
            self.plane_offsets.as_ptr().addr()
        }

        #[wasm_bindgen(getter, js_name = planeOffsetsLen)]
        pub fn wasm_plane_offsets_len(&self) -> usize {
            self.plane_offsets.len()
        }

        #[wasm_bindgen(getter, js_name = endpointsPtr)]
        pub fn wasm_endpoints_ptr(&self) -> usize {
            self.endpoints.as_ptr().addr()
        }

        #[wasm_bindgen(getter, js_name = endpointsLen)]
        pub fn wasm_endpoints_len(&self) -> usize {
            self.endpoints.len()
        }

        #[wasm_bindgen(getter, js_name = diagnosticCountersPtr)]
        pub fn wasm_diagnostic_counters_ptr(&self) -> usize {
            self.diagnostic_counters.as_ptr().addr()
        }

        #[wasm_bindgen(getter, js_name = diagnosticCountersLen)]
        pub fn wasm_diagnostic_counters_len(&self) -> usize {
            self.diagnostic_counters.len()
        }
    }

    #[wasm_bindgen(js_name = slice_layer_batch)]
    pub fn slice_layer_batch_wasm(
        positions: &Float32Array,
        indices: &Uint32Array,
        planes: &Float64Array,
        deadline_check_interval: JsValue,
    ) -> Result<SliceBatchResult, JsValue> {
        let deadline_check_interval = parse_deadline_check_interval(&deadline_check_interval)?;
        let position_length = array_length(positions.length())?;
        let index_length = array_length(indices.length())?;
        let plane_length = array_length(planes.length())?;
        validate_request_lengths(
            position_length,
            index_length,
            plane_length,
            deadline_check_interval,
        )?;

        let interval = usize::try_from(deadline_check_interval)
            .map_err(|_| SliceKernelError::new(SliceKernelErrorCode::IntegerOverflow))?;
        let mut abort_check = || {
            let value =
                deadline_should_abort().map_err(|_| SliceKernelErrorCode::DeadlineCheckFailed)?;
            value
                .as_bool()
                .ok_or(SliceKernelErrorCode::DeadlineCheckFailed)
        };
        check_deadline(&mut abort_check)?;
        let positions = copy_float32(positions, position_length, interval, &mut abort_check)?;
        let indices = copy_uint32(indices, index_length, interval, &mut abort_check)?;
        let planes = copy_float64(planes, plane_length, interval, &mut abort_check)?;
        slice_layer_batch_with_abort_check(
            &positions,
            &indices,
            &planes,
            deadline_check_interval,
            abort_check,
        )
        .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}
