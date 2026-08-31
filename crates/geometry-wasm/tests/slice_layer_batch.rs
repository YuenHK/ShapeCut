use shapecut_geometry_wasm::{
    DIAGNOSTIC_CHECKPOINT_COUNT, DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT,
    DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT, DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT,
    DIAGNOSTIC_NON_FINITE_INPUT_COUNT, DIAGNOSTIC_ON_PLANE_EDGE_COUNT,
    DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT, DIAGNOSTIC_SEGMENT_COUNT, MAX_DEADLINE_CHECK_INTERVAL,
    MAX_PLANE_COUNT, MAX_PLANE_TRIANGLE_TESTS, RESULT_VERSION, STATUS_GEOMETRY_EVIDENCE, STATUS_OK,
    SliceKernelErrorCode, slice_layer_batch, slice_layer_batch_with_abort_check,
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
    assert_eq!(result.diagnostic_counters()[DIAGNOSTIC_CHECKPOINT_COUNT], 5);
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
fn rejects_checkpoint_interval_above_the_bounded_maximum() {
    assert_eq!(
        error_code(&[0.0, 0.0, 0.0], &[], &[], MAX_DEADLINE_CHECK_INTERVAL + 1,),
        SliceKernelErrorCode::DeadlineCheckIntervalLimit
    );
}

#[test]
fn bounded_abort_hook_stops_work_at_a_checkpoint() {
    let (positions, indices) = tetrahedron();
    let mut checks = 0;
    let error = slice_layer_batch_with_abort_check(&positions, &indices, &[0.5, 1.0], 2, || {
        checks += 1;
        Ok(checks >= 2)
    })
    .expect_err("second checkpoint must stop the batch");

    assert_eq!(error.code(), SliceKernelErrorCode::DeadlineExceeded);
    assert_eq!(checks, 2);
}

#[test]
fn validation_checkpoints_large_inputs_even_without_plane_work() {
    let positions = vec![0.0_f32; (MAX_DEADLINE_CHECK_INTERVAL as usize * 3) + 3];
    let mut checks = 0_u32;
    let result = slice_layer_batch_with_abort_check(&positions, &[], &[], 4_096, || {
        checks += 1;
        Ok(false)
    })
    .expect("finite unreferenced vertices are valid");

    assert_eq!(result.plane_offsets(), &[0]);
    assert!(
        checks >= 4,
        "large finite validation must checkpoint in chunks, observed {checks} checks"
    );
}

#[test]
fn index_validation_and_degeneracy_prepass_are_both_checkpointed() {
    const TRIANGLE_COUNT: usize = 5_000;
    let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut indices = Vec::with_capacity(TRIANGLE_COUNT * 3);
    for _ in 0..TRIANGLE_COUNT {
        indices.extend_from_slice(&[0, 1, 2]);
    }
    let mut checks = 0_u32;
    let result = slice_layer_batch_with_abort_check(&positions, &indices, &[], 4_096, || {
        checks += 1;
        Ok(false)
    })
    .expect("valid triangles with no requested planes are accepted");

    assert_eq!(result.plane_offsets(), &[0]);
    assert!(
        checks >= 7,
        "copy-independent validation and prepass must checkpoint, observed {checks} checks"
    );
}

#[test]
fn empty_triangle_plane_traversal_has_an_independent_bounded_checkpoint() {
    let planes: Vec<f64> = (0..MAX_PLANE_COUNT).map(|plane| plane as f64).collect();
    let mut checks = 0_u32;
    let error = slice_layer_batch_with_abort_check(&[], &[], &planes, 4_096, || {
        checks += 1;
        Ok(checks >= 6)
    })
    .expect_err("the first plane-traversal checkpoint must observe cancellation");

    assert_eq!(error.code(), SliceKernelErrorCode::DeadlineExceeded);
    assert_eq!(checks, 6);
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

#[test]
fn huge_xy_extent_does_not_turn_tiny_axial_crossing_into_coplanar_evidence() {
    let positions = [0.0, 0.0, -0.0001, 1.0e12, 0.0, 0.0001, 0.0, 1.0e12, 0.0001];
    let result = slice_layer_batch(&positions, &[0, 1, 2], &[0.0], 1).unwrap();

    assert_eq!(result.status_code(), STATUS_OK);
    assert_eq!(result.plane_offsets(), &[0, 1]);
}

#[test]
fn mixed_scale_triangles_use_local_degeneracy_tolerance() {
    let positions = [
        0.0, 0.0, -1.0, 1.0e12, 0.0, 1.0, 0.0, 1.0e12, 1.0, // huge
        0.0, 0.0, -0.0001, 0.001, 0.0, 0.0001, 0.0, 0.001, 0.0001, // tiny
    ];
    let result = slice_layer_batch(&positions, &[0, 1, 2, 3, 4, 5], &[0.0], 1).unwrap();

    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT],
        0
    );
    assert_eq!(result.plane_offsets(), &[0, 2]);
}

#[test]
fn unreferenced_far_vertex_does_not_change_slice_or_evidence() {
    let base = [0.0, 0.0, -1.0, 2.0, 0.0, 1.0, 0.0, 2.0, 1.0];
    let mut with_far_vertex = base.to_vec();
    with_far_vertex.extend_from_slice(&[1.0e20, -1.0e20, 1.0e20]);

    let expected = slice_layer_batch(&base, &[0, 1, 2], &[0.0], 1).unwrap();
    let actual = slice_layer_batch(&with_far_vertex, &[0, 1, 2], &[0.0], 1).unwrap();
    assert_eq!(actual, expected);
}

#[test]
fn local_triangle_classification_is_axis_permutation_invariant() {
    let positions = [-2.0, -3.0, -4.0, 3.0, 2.0, -1.0, 1.0, -2.0, 5.0];
    for permutation in [[0, 1, 2], [1, 2, 0], [2, 0, 1]] {
        let mut permuted = Vec::new();
        for vertex in positions.as_chunks::<3>().0 {
            permuted.extend_from_slice(&[
                vertex[permutation[0]],
                vertex[permutation[1]],
                vertex[permutation[2]],
            ]);
        }
        let result = slice_layer_batch(&permuted, &[0, 1, 2], &[0.0], 1).unwrap();
        assert_eq!(result.status_code(), STATUS_OK);
        assert_eq!(result.plane_offsets(), &[0, 1]);
    }
}

#[test]
fn paired_shared_on_plane_edge_sets_geometry_evidence_status() {
    let positions = [0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, -1.0, -1.0];
    let result = slice_layer_batch(&positions, &[0, 1, 2, 1, 0, 3], &[0.0], 1).unwrap();

    assert_eq!(result.status_code(), STATUS_GEOMETRY_EVIDENCE);
    assert_eq!(result.plane_offsets(), &[0, 2]);
    assert_eq!(
        result.diagnostic_counters()[DIAGNOSTIC_ON_PLANE_EDGE_COUNT],
        2
    );
}

#[test]
fn large_batch_uses_bounded_geometric_endpoint_growth() {
    const TRIANGLE_COUNT: usize = 50_000;
    let positions = [0.0, 0.0, -1.0, 2.0, 0.0, 1.0, 0.0, 2.0, 1.0];
    let mut indices = Vec::with_capacity(TRIANGLE_COUNT * 3);
    for _ in 0..TRIANGLE_COUNT {
        indices.extend_from_slice(&[0, 1, 2]);
    }
    let result = slice_layer_batch(&positions, &indices, &[0.0], 256).unwrap();

    assert_eq!(result.plane_offsets(), &[0, TRIANGLE_COUNT as u32]);
    let growths = result.diagnostic_counters()[DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT];
    assert!(growths > 0);
    assert!(
        growths <= 8,
        "expected geometric growth, observed {growths} allocations"
    );
}
