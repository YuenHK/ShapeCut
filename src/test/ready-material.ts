import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import type { MaterialProfileV1 } from '../domain/materials/schema';

export const READY_TEST_MATERIAL: MaterialProfileV1 = Object.freeze({
  ...defaultPendingMaterialProfile('plywood-3')!,
  id: 'test-only-ready-birch-b42',
  machine: 'TEST ONLY qualified laser machine',
  materialCode: 'TEST-BIRCH-PLY-B42',
  materialName: 'TEST ONLY ready birch plywood',
  batchNotes: 'TEST ONLY exact manufacturer batch B42 measured at four corners',
  calibratedAt: '2026-07-19T01:02:03.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'Test Operator',
    qualification: 'TEST ONLY qualified laser cutter operator',
    signedAt: '2026-07-19T01:02:03.000Z',
    signature: 'TEST-OPERATOR-SIGNATURE-B42',
    couponId: 'TEST-COUPON-B42',
  },
  safetyEvidence: {
    kind: 'allowlisted' as const,
    category: 'laser-approved-plywood' as const,
    compositionKnown: true,
    manufacturer: 'TEST ONLY Timber Company',
    productId: 'TEST BIRCH PLY B42',
    laserSafetyReference: 'TEST ONLY manufacturer safety reference B42',
  },
});

export const BLOCKED_TEST_MATERIAL: MaterialProfileV1 = Object.freeze({
  ...READY_TEST_MATERIAL,
  id: 'test-only-blocked-custom-material',
  materialCode: 'TEST-CUSTOM-MATERIAL-BLOCKED',
  materialName: 'TEST ONLY custom material with unknown composition',
  safetyEvidence: {
    kind: 'custom' as const,
    compositionKnown: false,
    manufacturer: 'TEST ONLY Custom Company',
    productId: 'TEST CUSTOM MATERIAL B42',
    laserSafetyReference: 'TEST ONLY custom safety reference B42',
  },
});
