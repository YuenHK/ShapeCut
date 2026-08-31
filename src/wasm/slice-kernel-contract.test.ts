import { describe, expect, it } from 'vitest';

import {
  CanonicalFallbackGuard,
  SliceKernelError,
  parseSliceBatchResult as parseResult,
  readSliceKernelAbort,
  validateSliceBatchRequest as validateRequest,
  type SliceBatchRequest,
} from './slice-kernel-contract';

const RESULT_VERSION = 1;
const STATUS_OK = 0;
const DIAGNOSTIC_COUNTER_COUNT = 9;
const continueCheckpoint = (): undefined => undefined;

function parseSliceBatchResult(value: unknown, activeRequest: SliceBatchRequest) {
  return parseResult(value, activeRequest, continueCheckpoint);
}

function validateSliceBatchRequest(value: unknown) {
  return validateRequest(value, continueCheckpoint);
}

function request(overrides: Partial<SliceBatchRequest> = {}): SliceBatchRequest {
  return {
    positions: new Float32Array([
      0, 0, -1,
      2, 0, 1,
      0, 2, 1,
    ]),
    indices: new Uint32Array([0, 1, 2]),
    planes: new Float64Array([0]),
    deadlineCheckInterval: 4_096,
    ...overrides,
  };
}

function encodedResult(overrides: Partial<{
  version: unknown;
  statusCode: unknown;
  planeOffsets: unknown;
  endpoints: unknown;
  diagnosticCounters: unknown;
}> = {}): unknown {
  const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
  diagnosticCounters[3] = 1;
  diagnosticCounters[4] = 1;
  return {
    version: RESULT_VERSION,
    statusCode: STATUS_OK,
    planeOffsets: new Uint32Array([0, 1]),
    endpoints: new Float64Array([0, 0, 1, 1]),
    diagnosticCounters,
    ...overrides,
  };
}

function expectKernelCode(action: () => unknown, code: SliceKernelError['code']): void {
  expect(action).toThrowError(expect.objectContaining({ name: 'SliceKernelError', code }));
}

function captureFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected action to fail');
}

function expectValidationAndFallbackDenied(
  action: () => unknown,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
): void {
  const error = captureFailure(action);
  expect(error).toMatchObject({ name: 'SliceKernelError', code });
  expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
    expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
  );
}

const hostileRecordCases = [
  ['revoked', <T extends object>(target: T): T => {
    const pair = Proxy.revocable(target, {});
    pair.revoke();
    return pair.proxy;
  }],
  ['prototype trap', <T extends object>(target: T): T => new Proxy(target, {
    getPrototypeOf: () => { throw new Error('private prototype detail'); },
  })],
  ['ownKeys trap', <T extends object>(target: T): T => new Proxy(target, {
    ownKeys: () => { throw new Error('private ownKeys detail'); },
  })],
  ['descriptor trap', <T extends object>(target: T): T => new Proxy(target, {
    getOwnPropertyDescriptor: () => { throw new Error('private descriptor detail'); },
  })],
] as const;

function withThrowingOwnProperty<T extends object>(target: T, key: PropertyKey): T {
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => { throw new Error(`private ${String(key)} detail`); },
  });
  return target;
}

function detachedView<T extends Float32Array | Uint32Array>(view: T): T {
  structuredClone(view.buffer, { transfer: [view.buffer] });
  return view;
}

describe('TypeScript WASM slice contract', () => {
  it('rejects malformed result versions and statuses', () => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
      'INVALID_RESULT',
    );
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ statusCode: 2 }), request()),
      'INVALID_RESULT',
    );
  });

  it.each([
    new Uint32Array([1, 1]),
    new Uint32Array([0, 2]),
    new Uint32Array([0, 1, 0]),
  ])('rejects malformed and extra plane offsets %#', (planeOffsets) => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ planeOffsets }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects an endpoint length that cannot encode complete segments', () => {
    expectKernelCode(
      () => parseSliceBatchResult(
        encodedResult({ endpoints: new Float64Array([0, 0, 1]) }),
        request(),
      ),
      'INVALID_RESULT',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite endpoint %s',
    (value) => {
      expectKernelCode(
        () => parseSliceBatchResult(
          encodedResult({ endpoints: new Float64Array([0, 0, 1, value]) }),
          request(),
        ),
        'INVALID_RESULT',
      );
    },
  );

  it('rejects diagnostic counters that exceed request-derived limits', () => {
    const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
    diagnosticCounters[3] = 0xffff_ffff;
    diagnosticCounters[4] = 1;
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ diagnosticCounters }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects typed-array allocation lengths above the approved hard caps', () => {
    const oversizedEndpoints = new Float64Array((8 * 1024 * 1024 / 8) + 1);
    expectKernelCode(
      () => parseSliceBatchResult(
        encodedResult({ endpoints: oversizedEndpoints }),
        request(),
      ),
      'RESOURCE_LIMIT',
    );
  });

  it.each([
    ['positions', new Float64Array(3)],
    ['indices', new Int32Array(3)],
    ['planes', new Float32Array(1)],
  ] as const)('rejects the wrong %s typed array before WASM', (key, value) => {
    expectKernelCode(
      () => validateSliceBatchRequest({ ...request(), [key]: value } as unknown),
      'INVALID_REQUEST',
    );
  });

  it.each([
    ['planeOffsets', new Int32Array([0, 1])],
    ['endpoints', new Float32Array([0, 0, 1, 1])],
    ['diagnosticCounters', new BigUint64Array(DIAGNOSTIC_COUNTER_COUNT)],
  ] as const)('rejects the wrong result %s typed array', (key, value) => {
    expectKernelCode(
      () => parseSliceBatchResult(encodedResult({ [key]: value }), request()),
      'INVALID_RESULT',
    );
  });

  it('uses strict schemas that reject unrecognized request and result fields', () => {
    expectKernelCode(
      () => validateSliceBatchRequest({ ...request(), unexpected: true }),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => parseSliceBatchResult(
        { ...(encodedResult() as object), unexpected: true },
        request(),
      ),
      'INVALID_RESULT',
    );
  });

  it('rejects hidden strings, symbols, and unexpected accessors via Reflect.ownKeys', () => {
    const hiddenRequest = request() as SliceBatchRequest & Record<PropertyKey, unknown>;
    Object.defineProperty(hiddenRequest, 'hidden', { value: true, enumerable: false });
    expectKernelCode(() => validateSliceBatchRequest(hiddenRequest), 'INVALID_REQUEST');

    const symbolResult = encodedResult() as Record<PropertyKey, unknown>;
    symbolResult[Symbol('extra')] = true;
    expectKernelCode(() => parseSliceBatchResult(symbolResult, request()), 'INVALID_RESULT');

    const accessorResult = encodedResult() as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorResult, 'unexpectedAccessor', {
      configurable: true,
      get: () => true,
    });
    expectKernelCode(() => parseSliceBatchResult(accessorResult, request()), 'INVALID_RESULT');
  });

  it.each(hostileRecordCases)(
    'fails closed for direct request/result strict-record %s and denies fallback',
    (_name, wrap) => {
      expectValidationAndFallbackDenied(
        () => validateSliceBatchRequest(wrap(request())),
        'INVALID_REQUEST',
      );
      expectValidationAndFallbackDenied(
        () => parseSliceBatchResult(wrap(encodedResult() as object), request()),
        'INVALID_RESULT',
      );
    },
  );

  it('uses verified record descriptor values without invoking hostile get traps', () => {
    const requestProxy = new Proxy(request(), {
      get: () => { throw new Error('ordinary request get must not run'); },
    });
    expect(validateSliceBatchRequest(requestProxy)).toMatchObject({ deadlineCheckInterval: 4_096 });

    const resultProxy = new Proxy(encodedResult() as object, {
      get: () => { throw new Error('ordinary result get must not run'); },
    });
    expect(parseSliceBatchResult(resultProxy, request())).toMatchObject({ version: RESULT_VERSION });
  });

  it.each([
    ['Proxy-wrapped', () => new Proxy(new Float32Array([0, 0, 0]), {})],
    ['own constructor', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'constructor')],
    ['own buffer', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'buffer')],
    ['own length', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'length')],
    ['detached', () => detachedView(new Float32Array([0, 0, 0]))],
    ['shared backing buffer', () => new Float32Array(new SharedArrayBuffer(12))],
    ['non-zero offset', () => new Float32Array(new ArrayBuffer(16), 4, 3)],
    ['partial backing buffer', () => new Float32Array(new ArrayBuffer(16), 0, 3)],
  ] as const)('rejects %s request typed arrays with INVALID_REQUEST and no fallback', (_name, value) => {
    expectValidationAndFallbackDenied(
      () => validateSliceBatchRequest(request({ positions: value() as Float32Array })),
      'INVALID_REQUEST',
    );
  });

  it.each([
    ['Proxy-wrapped', () => new Proxy(new Uint32Array([0, 1]), {})],
    ['own constructor', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'constructor')],
    ['own buffer', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'buffer')],
    ['own length', () => withThrowingOwnProperty(new Uint32Array([0, 1]), 'length')],
    ['detached', () => detachedView(new Uint32Array([0, 1]))],
    ['shared backing buffer', () => new Uint32Array(new SharedArrayBuffer(8))],
    ['non-zero offset', () => new Uint32Array(new ArrayBuffer(12), 4, 2)],
    ['partial backing buffer', () => new Uint32Array(new ArrayBuffer(12), 0, 2)],
    ['misaligned spoof', () => {
      const fake = Object.create(Uint32Array.prototype);
      Object.defineProperties(fake, {
        buffer: { value: new ArrayBuffer(8) },
        byteOffset: { value: 2 },
        byteLength: { value: 8 },
        length: { value: 2 },
        constructor: { value: Uint32Array },
      });
      return fake;
    }],
  ] as const)('rejects %s result typed arrays with INVALID_RESULT and no fallback', (_name, value) => {
    expectValidationAndFallbackDenied(
      () => parseSliceBatchResult(encodedResult({ planeOffsets: value() }), request()),
      'INVALID_RESULT',
    );
  });

  it('rejects unsafe request counts and malformed finite/index data before WASM', () => {
    expectKernelCode(
      () => validateSliceBatchRequest(request({ deadlineCheckInterval: Number.MAX_SAFE_INTEGER + 1 })),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => validateSliceBatchRequest(request({ positions: new Float32Array([0, 0, Number.NaN]) })),
      'INVALID_REQUEST',
    );
    expectKernelCode(
      () => validateSliceBatchRequest(request({ indices: new Uint32Array([0, 1, 3]) })),
      'INVALID_REQUEST',
    );
  });

  it('accepts only exact reason/source abort records at the public adapter boundary', () => {
    expect(readSliceKernelAbort(() => ({ reason: 'cancelled', source: 'user' })))
      .toEqual({ reason: 'cancelled', source: 'user' });
    expect(readSliceKernelAbort(() => ({ reason: 'deadline', source: 'runtime-deadline' })))
      .toEqual({ reason: 'deadline', source: 'runtime-deadline' });
    expectKernelCode(() => readSliceKernelAbort(() => false as never), 'DEADLINE_CHECK_FAILED');
    expectKernelCode(
      () => readSliceKernelAbort(
        () => ({ reason: 'cancelled', source: 'runtime-deadline' } as never),
      ),
      'DEADLINE_CHECK_FAILED',
    );
  });

  it('returns a frozen public record over controlled-wrapper owned typed arrays', () => {
    const parsed = parseSliceBatchResult(encodedResult(), request());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Array.from(parsed.planeOffsets)).toEqual([0, 1]);
    expect(Array.from(parsed.endpoints)).toEqual([0, 0, 1, 1]);
    expect(parsed.diagnosticCounters.at(4)).toBe(1);
  });

  it('prevents index, set, and fill mutation of validated public values', () => {
    const parsed = parseSliceBatchResult(encodedResult(), request());
    const publicOffsets = parsed.planeOffsets as unknown as Uint32Array;

    expect(() => { publicOffsets[0] = 99; }).toThrow(TypeError);
    expect(() => publicOffsets.set(new Uint32Array([99]), 0)).toThrow(TypeError);
    expect(() => publicOffsets.fill(99)).toThrow(TypeError);
    expect(Array.from(parsed.planeOffsets)).toEqual([0, 1]);
  });

  it('atomically claims fallback publication and rejects an interleaved late WASM claim', async () => {
    const guard = new CanonicalFallbackGuard();
    const loadFailure = new SliceKernelError('LOAD_FAILED', 'sanitized');
    const fallbackToken = guard.claimTypeScriptFallback(loadFailure);

    await Promise.resolve();
    expectKernelCode(() => guard.claimWasmPublication(), 'PUBLICATION_CONFLICT');
    await expect(guard.publishCanonicalResult(fallbackToken, async () => 'fallback'))
      .resolves.toBe('fallback');
  });

  it('keeps a non-hostile validated INVALID_RESULT eligible before publication', () => {
    const error = captureFailure(
      () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
    );
    expect(error).toMatchObject({
      name: 'SliceKernelError',
      code: 'INVALID_RESULT',
      fallbackEligible: true,
    });
    expect(new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toBeDefined();
  });

  it('rejects forged, late, and duplicate publication tokens', () => {
    const guard = new CanonicalFallbackGuard();
    const wasmToken = guard.claimWasmPublication();

    expectKernelCode(
      () => guard.publishCanonicalResult({} as never, () => undefined),
      'PUBLICATION_CONFLICT',
    );
    expect(guard.publishCanonicalResult(wasmToken, () => 'wasm')).toBe('wasm');
    expectKernelCode(
      () => guard.publishCanonicalResult(wasmToken, () => undefined),
      'PUBLICATION_CONFLICT',
    );
    expectKernelCode(
      () => guard.claimTypeScriptFallback(new SliceKernelError('LOAD_FAILED', 'sanitized')),
      'PUBLICATION_CONFLICT',
    );
  });

  it.each(['CANCELLED', 'DEADLINE_EXCEEDED', 'DEADLINE_CHECK_FAILED'] as const)(
    'never downgrades %s to compatibility fallback',
    (code) => {
      const guard = new CanonicalFallbackGuard();
      expectKernelCode(
        () => guard.claimTypeScriptFallback(new SliceKernelError(code, 'sanitized')),
        'FALLBACK_NOT_ALLOWED',
      );
    },
  );

  it('marks publication before invoking the publisher so thrown publication cannot reopen fallback', () => {
    const guard = new CanonicalFallbackGuard();
    const token = guard.claimWasmPublication();
    expect(() => guard.publishCanonicalResult(token, () => { throw new Error('publisher failed'); }))
      .toThrow('publisher failed');
    expectKernelCode(
      () => guard.claimTypeScriptFallback(new SliceKernelError('LOAD_FAILED', 'sanitized')),
      'PUBLICATION_CONFLICT',
    );
  });
});
