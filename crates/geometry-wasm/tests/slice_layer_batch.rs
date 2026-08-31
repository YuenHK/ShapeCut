use shapecut_geometry_wasm::{
    DIAGNOSTIC_CHECKPOINT_COUNT, DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT,
    DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT, DIAGNOSTIC_NON_FINITE_INPUT_COUNT,
    DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT, DIAGNOSTIC_SEGMENT_COUNT, MAX_PLANE_COUNT,
    MAX_PLANE_TRIANGLE_TESTS, RESULT_VERSION, STATUS_GEOMETRY_EVIDENCE, STATUS_OK,
    SliceKernelErrorCode, slice_layer_batch,
};

fn tetrahedron() -> (Vec<f32>, Vec<u32>) {
    (
        vec![
            0.0, 0.0, 0.0, // 0
            2.0, 0.0, 0.0, // 1
            0.0, 2.0, 0.0, // 2
            0.0, 0.0, 2.0, // 3
        ],
        vec![
            0, 2, 1, // base
            0, 1, 3, // y = 0
            1, 2, 3, // sloped face
            2, 0, 3, // x = 0
        ],
    )
}

fn error_code(
    positions: &[f32],
    indices: &[u32],
    planes: &[f64],
    interval: u32,
) -> SliceKernelErrorCode {
    slice_layer_batch(positions, indices, planes, interval)
        .expect_err("request should fail closed")
        .code()
}

#[test]
fn slices_tetrahedron_in_plane_triangle_edge_order() {
    let (positions, indices) = tetrahedron();
    let result = slice_layer_batch(&positions, &indices, &[0.5, 1.0], 2).unwrap();

    assert_eq!(result.version(), RESULT_VERSION);
    assert_eq!(result.status_code(), STATUS_OK);
    assert_eq!(result.plane_offsets(), &[0, 3, 6]);
    assert_eq!(
        result.endpoints(),
        &[
            // plane 0.5, triangle 1, crossing edges 1 then 2
            1.5, 0.0, 0.0, 0.0, // triangle 2
            0.0, 1.5, 1.5, 0.0, // triangle 3
            0.0, 0.0, 0.0, 1.5, // plane 1.0, triangle 1
            1.0, 0.0, 0.0, 0.0, // triangle 2
            0.0, 1.0, 1.0, 0.0, // triangle 3
            0.0, 0.0, 0.0, 1.0,
        ]
    );
    assert_eq!(result.diagnostic_counters()[DIAGNOSTIC_SEGMENT_COUNT], 6);
    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT],
        8
    );
    assert_eq!(result.diagnostic_counters()[DIAGNOSTIC_CHECKPOINT_COUNT], 4);
}

#[test]
fn reports_coplanar_triangle_evidence_without_inventing_a_segment() {
    let positions = [0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 2.0, 1.0];
    let result = slice_layer_batch(&positions, &[0, 1, 2], &[1.0], 1).unwrap();

    assert_eq!(result.status_code(), STATUS_GEOMETRY_EVIDENCE);
    assert_eq!(result.plane_offsets(), &[0, 0]);
    assert!(result.endpoints().is_empty());
    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT],
        1
    );
}

#[test]
fn reports_and_skips_a_degenerate_triangle() {
    let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 0.0, 2.0];
    let result = slice_layer_batch(&positions, &[0, 1, 2], &[1.0], 1).unwrap();

    assert_eq!(result.status_code(), STATUS_GEOMETRY_EVIDENCE);
    assert_eq!(result.plane_offsets(), &[0, 0]);
    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT],
        1
    );
}

#[test]
fn rejects_non_finite_positions_and_planes() {
    assert_eq!(
        error_code(&[0.0, 0.0, f32::NAN], &[], &[], 1),
        SliceKernelErrorCode::NonFinitePosition
    );
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &[f64::INFINITY], 1),
        SliceKernelErrorCode::NonFinitePlane
    );

    let (positions, indices) = tetrahedron();
    let result = slice_layer_batch(&positions, &indices, &[0.5], 1).unwrap();
    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_NON_FINITE_INPUT_COUNT],
        0
    );
}

#[test]
fn rejects_out_of_range_and_incomplete_triangle_indices() {
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[0, 0, 1], &[], 1),
        SliceKernelErrorCode::IndexOutOfRange
    );
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[0, 0], &[], 1),
        SliceKernelErrorCode::IncompleteTriangleIndices
    );
}

#[test]
fn rejects_incomplete_positions_and_non_strict_plane_order() {
    assert_eq!(
        error_code(&[0.0, 0.0], &[], &[], 1),
        SliceKernelErrorCode::IncompletePositions
    );
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &[1.0, 0.5], 1),
        SliceKernelErrorCode::UnsortedPlanes
    );
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &[1.0, 1.0], 1),
        SliceKernelErrorCode::UnsortedPlanes
    );
}

#[test]
fn rejects_zero_checkpoint_interval() {
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &[], 0),
        SliceKernelErrorCode::InvalidCheckpointInterval
    );
}

#[test]
fn rejects_plane_count_and_work_that_exceed_bounded_allocation_contracts() {
    let too_many_planes = vec![0.0; MAX_PLANE_COUNT + 1];
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &too_many_planes, 1),
        SliceKernelErrorCode::PlaneCountLimit
    );

    let plane_count = 501usize;
    let triangle_count = MAX_PLANE_TRIANGLE_TESTS / plane_count + 1;
    let mut indices = Vec::with_capacity(triangle_count * 3);
    for _ in 0..triangle_count {
        indices.extend_from_slice(&[0, 1, 2]);
    }
    let planes: Vec<f64> = (0..plane_count).map(|plane| plane as f64).collect();
    assert_eq!(
        error_code(
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &indices,
            &planes,
            256,
        ),
        SliceKernelErrorCode::WorkLimit
    );
}

#[test]
fn repeated_calls_are_bitwise_deterministic() {
    let (positions, indices) = tetrahedron();
    let first = slice_layer_batch(&positions, &indices, &[0.25, 0.75, 1.25], 3).unwrap();
    let second = slice_layer_batch(&positions, &indices, &[0.25, 0.75, 1.25], 3).unwrap();

    assert_eq!(first.version(), second.version());
    assert_eq!(first.status_code(), second.status_code());
    assert_eq!(first.plane_offsets(), second.plane_offsets());
    assert_eq!(
        first
            .endpoints()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        second
            .endpoints()
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>()
    );
    assert_eq!(first.diagnostic_counters(), second.diagnostic_counters());
}
