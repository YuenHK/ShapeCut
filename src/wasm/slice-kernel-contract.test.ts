import { describe, expect, it } from 'vitest';

import * as contractModule from './slice-kernel-contract';
import * as loaderModule from './load-slice-kernel';
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

function ordinaryInvalidResultFailure(): unknown {
  return captureFailure(
    () => parseSliceBatchResult(encodedResult({ version: 2 }), request()),
  );
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

function resizableView<T extends Float32Array | Float64Array | Uint32Array>(
  constructor: { new(buffer: ArrayBuffer): T; readonly BYTES_PER_ELEMENT: number },
  length: number,
): T {
  const ResizableArrayBuffer = ArrayBuffer as unknown as {
    new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
  };
  return new constructor(new ResizableArrayBuffer(
    length * constructor.BYTES_PER_ELEMENT,
    { maxByteLength: (length + 1) * constructor.BYTES_PER_ELEMENT },
  ));
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
    let checkpointCount = 0;
    const error = captureFailure(
      () => parseResult(
        encodedResult({ endpoints: oversizedEndpoints }),
        request(),
        () => {
          checkpointCount += 1;
          return undefined;
        },
      ),
    );
    expect(error).toMatchObject({ name: 'SliceKernelError', code: 'RESOURCE_LIMIT' });
    expect(checkpointCount).toBe(0);
    expect(new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toBeDefined();
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

  it.each(['LOAD_FAILED', 'EXECUTION_FAILED', 'INVALID_RESULT', 'RESOURCE_LIMIT'] as const)(
    'never lets public construction mint fallback provenance for %s',
    (code) => {
      const forgedDefault = new SliceKernelError(code, 'forged public error');
      const forgedExplicit = new SliceKernelError(
        code,
        'forged public error',
        undefined,
        true,
      );
      expect(forgedDefault.fallbackEligible).toBe(false);
      expect(forgedExplicit.fallbackEligible).toBe(false);
      expectKernelCode(
        () => new CanonicalFallbackGuard().claimTypeScriptFallback(forgedDefault),
        'FALLBACK_NOT_ALLOWED',
      );
      expectKernelCode(
        () => new CanonicalFallbackGuard().claimTypeScriptFallback(forgedExplicit),
        'FALLBACK_NOT_ALLOWED',
      );
    },
  );

  it('denies fallback provenance to public SliceKernelError subclasses', () => {
    class ForgedSliceKernelError extends SliceKernelError {}
    const forged = new ForgedSliceKernelError('LOAD_FAILED', 'forged subclass');
    expect(forged.fallbackEligible).toBe(false);
    expectKernelCode(
      () => new CanonicalFallbackGuard().claimTypeScriptFallback(forged),
      'FALLBACK_NOT_ALLOWED',
    );
  });

  it.each([
    ['own-property mutation', (source: SliceBatchRequest) => {
      Object.defineProperty(source.positions, 'length', {
        configurable: true,
        get: () => { throw new Error('reentrant caller property'); },
      });
    }],
    ['detach', (source: SliceBatchRequest) => {
      structuredClone(source.positions.buffer, { transfer: [source.positions.buffer] });
    }],
  ] as const)(
    'fails closed when a checkpoint mutates request lifecycle via %s',
    (_name, mutate) => {
      const source = request();
      let mutated = false;
      expectValidationAndFallbackDenied(
        () => validateRequest(source, () => {
          if (!mutated) {
            mutated = true;
            mutate(source);
          }
          return undefined;
        }),
        'INVALID_REQUEST',
      );
    },
  );

  it.each([
    ['own-property mutation', (marked: SliceBatchRequest) => {
      Object.defineProperty(marked.positions, 'length', { value: 0 });
    }],
    ['detach', (marked: SliceBatchRequest) => {
      structuredClone(marked.positions.buffer, { transfer: [marked.positions.buffer] });
    }],
    ['value mutation', (marked: SliceBatchRequest) => {
      marked.positions[0] = Number.NaN;
    }],
  ] as const)(
    'revalidates a previously marked request after %s and denies fallback',
    (_name, mutate) => {
      const marked = validateSliceBatchRequest(request());
      mutate(marked);
      expectValidationAndFallbackDenied(
        () => parseSliceBatchResult(encodedResult(), marked),
        'INVALID_REQUEST',
      );
    },
  );

  it('rejects resizable request and result buffers with typed validation and no fallback', () => {
    const resizablePositions = resizableView(Float32Array, 9);
    let requestCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => validateRequest(
      request({ positions: resizablePositions }),
      () => {
        requestCheckpointCount += 1;
        (resizablePositions.buffer as ArrayBuffer & { resize(length: number): void }).resize(0);
        return undefined;
      },
    ), 'INVALID_REQUEST');
    expect(requestCheckpointCount).toBe(0);

    const resizableOffsets = resizableView(Uint32Array, 2);
    let resultCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => parseResult(
      encodedResult({ planeOffsets: resizableOffsets }),
      request(),
      () => {
        resultCheckpointCount += 1;
        (resizableOffsets.buffer as ArrayBuffer & { resize(length: number): void }).resize(0);
        return undefined;
      },
    ), 'INVALID_RESULT');
    expect(resultCheckpointCount).toBe(0);
  });

  it.each([
    ['own-property mutation', (encoded: Record<string, unknown>) => {
      Object.defineProperty(encoded.endpoints, 'length', {
        configurable: true,
        get: () => { throw new Error('reentrant result property'); },
      });
    }],
    ['detach', (encoded: Record<string, unknown>) => {
      const endpoints = encoded.endpoints as Float64Array;
      structuredClone(endpoints.buffer, { transfer: [endpoints.buffer] });
    }],
  ] as const)(
    'fails closed when a checkpoint mutates result lifecycle via %s',
    (_name, mutate) => {
      const encoded = encodedResult() as Record<string, unknown>;
      let mutated = false;
      expectValidationAndFallbackDenied(
        () => parseResult(encoded, request(), () => {
          if (!mutated) {
            mutated = true;
            mutate(encoded);
          }
          return undefined;
        }),
        'INVALID_RESULT',
      );
    },
  );

  it('does not export an arbitrary eligible-error issuer or permit legacy mapper misuse', () => {
    const moduleRecord = contractModule as unknown as Record<string, unknown>;
    const legacyIssuer = moduleRecord.createSliceKernelRuntimeError;
    if (typeof legacyIssuer === 'function') {
      const forged = legacyIssuer('LOAD_FAILED', 'external misuse');
      expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(forged)).toThrowError(
        expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
      );
    }
    expect(Object.hasOwn(moduleRecord, 'createSliceKernelRuntimeError')).toBe(false);
    expect(Reflect.ownKeys(loaderModule).filter((key) => typeof key === 'string').sort()).toEqual([
      'disposeSliceKernel',
      'loadSliceKernel',
    ]);
  });

  it('does not grant ordinary-result fallback before complete typed-array inspection', () => {
    expectValidationAndFallbackDenied(
      () => parseSliceBatchResult(encodedResult({
        version: 2,
        planeOffsets: new Proxy(new Uint32Array([0, 1]), {}),
      }), request()),
      'INVALID_RESULT',
    );
  });

  it.each([
    [{ reason: 'cancelled', source: 'user' }, 'CANCELLED'],
    [{ reason: 'deadline', source: 'runtime-deadline' }, 'DEADLINE_EXCEEDED'],
  ] as const)(
    'preserves immediate and delayed snapshot abort $0.reason as $1',
    (abort, code) => {
      for (const trigger of [1, 5]) {
        let checkpointCount = 0;
        const error = captureFailure(() => validateRequest(request(), () => {
          checkpointCount += 1;
          return checkpointCount === trigger ? abort : undefined;
        }));
        expect(error).toMatchObject({
          name: 'SliceKernelError',
          code,
          abortSource: abort.source,
        });
        expect(checkpointCount).toBe(trigger);
        expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
          expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
        );
      }
    },
  );

  it('revalidates all caller views after a delayed checkpoint mutation', () => {
    const source = request();
    let requestCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => validateRequest(source, () => {
      requestCheckpointCount += 1;
      if (requestCheckpointCount === 5) {
        Object.defineProperty(source.positions, 'length', { value: 0 });
      }
      return undefined;
    }), 'INVALID_REQUEST');

    const encoded = encodedResult() as Record<string, unknown>;
    let resultCheckpointCount = 0;
    expectValidationAndFallbackDenied(() => parseResult(encoded, request(), () => {
      resultCheckpointCount += 1;
      if (resultCheckpointCount === 5) {
        const endpoints = encoded.endpoints as Float64Array;
        structuredClone(endpoints.buffer, { transfer: [endpoints.buffer] });
      }
      return undefined;
    }), 'INVALID_RESULT');
  });

  it('checkpoints intrinsic defensive copies in bounded chunks near the approved interval', () => {
    const positions = new Float32Array((4_096 * 2) + 1);
    let checkpointCount = 0;
    validateRequest(request({ positions }), () => {
      checkpointCount += 1;
      return undefined;
    });
    expect(checkpointCount).toBeGreaterThanOrEqual(17);
  });

  it('checkpoints near-limit result copies in bounded intrinsic chunks', () => {
    const endpointLength = (4_096 * 2) + 4;
    const segmentCount = endpointLength / 4;
    const diagnosticCounters = new Uint32Array(DIAGNOSTIC_COUNTER_COUNT);
    diagnosticCounters[3] = 1;
    diagnosticCounters[4] = segmentCount;
    let checkpointCount = 0;
    const parsed = parseResult(encodedResult({
      planeOffsets: new Uint32Array([0, segmentCount]),
      endpoints: new Float64Array(endpointLength),
      diagnosticCounters,
    }), request(), () => {
      checkpointCount += 1;
      return undefined;
    });
    expect(parsed.endpoints).toHaveLength(endpointLength);
    expect(checkpointCount).toBeGreaterThanOrEqual(32);
  });

  it('rejects a request allocation above its explicit cap before any checkpoint or fallback', () => {
    const oversizedPlanes = new Float64Array(16_385);
    let checkpointCount = 0;
    const error = captureFailure(() => validateRequest(
      request({ planes: oversizedPlanes }),
      () => {
        checkpointCount += 1;
        return undefined;
      },
    ));
    expect(error).toMatchObject({ name: 'SliceKernelError', code: 'RESOURCE_LIMIT' });
    expect(checkpointCount).toBe(0);
    expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
      expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
    );
  });

  it('atomically claims fallback publication and rejects an interleaved late WASM claim', async () => {
    const guard = new CanonicalFallbackGuard();
    const fallbackToken = guard.claimTypeScriptFallback(ordinaryInvalidResultFailure());

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
      () => guard.claimTypeScriptFallback(ordinaryInvalidResultFailure()),
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
      () => guard.claimTypeScriptFallback(ordinaryInvalidResultFailure()),
      'PUBLICATION_CONFLICT',
    );
  });
});
